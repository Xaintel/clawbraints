#!/usr/bin/env python3
"""Codex skill handler for controlled non-interactive execution."""

from __future__ import annotations

import json
import re
import shlex
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from runner.db import insert_audit_event
from runner.logging import append_log
from shared.policy import (
    PolicyError,
    normalize_command,
    resolve_repo_path,
    validate_agent,
    validate_command_whitelist,
    validate_paths_write,
    validate_repo_allowed,
)

ALLOWED_SKILL_AGENTS = {
    "TranslatorAgent",
    "PMAgent",
    "MobileAgent",
    "OCRAgent",
    "QAAgent",
    "CoderAgent",
    "BuilderAgent",
    "UXAgent",
}
RECOVERABLE_STDERR_HINTS = (
    "failed to record rollout items",
    "failed to queue rollout items",
    "channel closed",
    "stream disconnected",
    "error decoding response body",
    "connection reset by peer",
)
NON_RECOVERABLE_STDERR_HINTS = (
    "permission denied",
    "command not found",
    "no such file or directory",
    "not inside a trusted directory",
    "authentication",
    "unauthorized",
    "forbidden",
    "policy_denied",
    "invalid api key",
)


def _truncate_text(value: str, max_bytes: int) -> tuple[str, bool]:
    data = value.encode("utf-8")
    if len(data) <= max_bytes:
        return value, False
    truncated = data[:max_bytes].decode("utf-8", errors="ignore")
    return truncated, True


def _coerce_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        return value
    return ""


def _is_recoverable_nonzero_exit(
    *,
    stderr_text: str,
    diff_saved: bool,
    workspace_dirty: bool,
) -> bool:
    stderr_low = stderr_text.lower()
    if any(token in stderr_low for token in NON_RECOVERABLE_STDERR_HINTS):
        return False
    if any(token in stderr_low for token in RECOVERABLE_STDERR_HINTS):
        return True
    if diff_saved or workspace_dirty:
        return True
    return False


def _safe_segment(value: str, *, default: str) -> str:
    raw = value.strip().lower() if isinstance(value, str) else ""
    if not raw:
        return default
    cleaned = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")
    return cleaned or default


def _safe_artifacts_dir(task_id: str, artifacts_root: Path, agent: str) -> Path:
    if not task_id or "/" in task_id or "\\" in task_id:
        raise PolicyError("invalid task_id for artifacts path")
    root = artifacts_root.resolve()
    agent_segment = _safe_segment(agent, default="agent")
    target = (root / agent_segment / task_id).resolve()
    if not target.is_relative_to(root):
        raise PolicyError(f"artifacts path escapes root: {target}")
    target.mkdir(parents=True, exist_ok=True)
    return target


def _append_event(events_path: Path, event_type: str, detail: dict[str, Any]) -> None:
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event_type,
        "detail": detail,
    }
    with events_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


def _load_agents_context(repo_path: Path) -> str:
    agents_md = repo_path / "AGENTS.md"
    if not agents_md.is_file():
        return "AGENTS.md not found."
    text = agents_md.read_text(encoding="utf-8")
    if not text.strip():
        return "AGENTS.md exists but is empty."
    return text.strip()


def _build_prompt(
    *,
    request_text: str,
    repo: str,
    agent: str,
    agents_context: str,
) -> str:
    return (
        f"Task request:\n{request_text.strip()}\n\n"
        f"Repository: {repo}\n"
        f"Agent: {agent}\n\n"
        "Repository AGENTS.md context:\n"
        f"{agents_context}\n\n"
        "Execution constraints:\n"
        "- Operate only inside the repository.\n"
        "- Do not expose secrets.\n"
        "- Produce minimal, reviewable changes.\n"
        "- Summarize what changed.\n"
    )


def _write_manual_artifacts(
    *,
    artifact_dir: Path,
    prompt_path: Path,
    command_raw: str,
    repo_path: Path,
) -> Path:
    run_path = artifact_dir / "run.sh"
    expected_path = artifact_dir / "expected_outputs.md"

    script = (
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"cd {shlex.quote(str(repo_path))}\n"
        f"cat {shlex.quote(str(prompt_path))} | {command_raw}\n"
    )
    run_path.write_text(script, encoding="utf-8")
    run_path.chmod(0o755)

    expected = (
        "# Expected outputs\n\n"
        "- Execute `run.sh` from this folder.\n"
        "- Review repo changes and generated `diff.patch`.\n"
        "- Update task summary based on the applied changes.\n"
    )
    expected_path.write_text(expected, encoding="utf-8")
    return run_path


def run_codex_skill(
    *,
    task_id: str,
    repo: str,
    agent: str,
    request_text: str,
    command_raw: str,
    policy: Any,
    db_path: Path,
    worker_user: str,
    log_path: Path,
    logs_dir: Path,
    artifacts_root: Path,
    command_timeout: int,
    max_output_bytes: int,
) -> dict[str, Any]:
    if agent not in ALLOWED_SKILL_AGENTS:
        raise PolicyError(f"codex skill not allowed for agent: {agent}")

    validate_agent(policy, agent)
    validate_repo_allowed(policy, repo)
    repo_path = resolve_repo_path(policy, repo)

    if not command_raw.strip():
        command_raw = (
            f"codex exec --skip-git-repo-check --sandbox workspace-write "
            f"-C {repo_path} -"
        )

    argv = validate_command_whitelist(policy, agent, command_raw)
    command_normalized, _ = normalize_command(command_raw)

    artifacts_root_resolved = artifacts_root.resolve()
    validate_paths_write(policy, artifacts_root_resolved)
    artifact_dir = _safe_artifacts_dir(task_id, artifacts_root_resolved, agent)
    validate_paths_write(policy, artifact_dir)
    events_path = artifact_dir / "events.jsonl"
    summary_path = artifact_dir / "summary.md"
    final_message_path = artifact_dir / "final_message.txt"
    diff_path = artifact_dir / "diff.patch"

    # Always create these artifact files so IDE download endpoints have stable targets.
    if not diff_path.exists():
        diff_path.write_text("", encoding="utf-8")

    prompt_text = _build_prompt(
        request_text=request_text,
        repo=repo,
        agent=agent,
        agents_context=_load_agents_context(repo_path),
    )
    prompt_path = artifact_dir / "prompt.txt"
    prompt_path.write_text(prompt_text, encoding="utf-8")

    run_path = _write_manual_artifacts(
        artifact_dir=artifact_dir,
        prompt_path=prompt_path,
        command_raw=command_normalized,
        repo_path=repo_path,
    )

    insert_audit_event(
        db_path,
        task_id=task_id,
        actor_type="agent",
        actor=agent,
        action="codex_invoked",
        detail={
            "command": command_normalized,
            "repo_path": str(repo_path),
            "artifact_dir": str(artifact_dir),
        },
    )
    _append_event(
        events_path,
        "codex_invoked",
        {
            "command": command_normalized,
            "repo_path": str(repo_path),
            "artifact_dir": str(artifact_dir),
        },
    )
    append_log(log_path, f"codex_invoked: {command_normalized}", logs_dir=logs_dir)

    if shutil.which(argv[0]) is None:
        reason = "codex CLI not available"
        insert_audit_event(
            db_path,
            task_id=task_id,
            actor_type="system",
            actor=worker_user,
            action="codex_manual_required",
            detail={"reason": reason, "run_script": str(run_path)},
        )
        summary_message = f"BLOCKED: codex manual required. Run {run_path}"
        summary_path.write_text(
            "# Codex execution summary\n\n"
            f"Manual step required: {reason}.\n"
            f"Run: {run_path}\n",
            encoding="utf-8",
        )
        final_message_path.write_text(summary_message + "\n", encoding="utf-8")
        _append_event(
            events_path,
            "codex_manual_required",
            {"reason": reason, "run_script": str(run_path)},
        )
        insert_audit_event(
            db_path,
            task_id=task_id,
            actor_type="agent",
            actor=agent,
            action="codex_result",
            detail={
                "status": "blocked",
                "exit_code": None,
                "timed_out": False,
                "stdout": "",
                "stderr": reason,
                "stdout_truncated": False,
                "stderr_truncated": False,
                "summary_path": str(summary_path),
                "diff_path": str(diff_path),
                "manual_run_script": str(run_path),
            },
        )
        _append_event(
            events_path,
            "codex_result",
            {
                "status": "blocked",
                "exit_code": None,
                "manual_required": True,
                "summary": summary_message,
            },
        )
        return {
            "status": "blocked",
            "summary": summary_message,
            "exit_code": None,
            "artifacts_dir": str(artifact_dir),
            "manual_required": True,
        }

    try:
        subprocess.run(
            ["git", "config", "--global", "--add", "safe.directory", str(repo_path)],
            cwd=str(repo_path),
            shell=False,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
    except OSError:
        pass

    timed_out = False
    try:
        result = subprocess.run(
            argv,
            cwd=str(repo_path),
            shell=False,
            input=prompt_text,
            text=True,
            capture_output=True,
            timeout=command_timeout,
            check=False,
        )
        exit_code = int(result.returncode)
        stdout_raw = result.stdout or ""
        stderr_raw = result.stderr or ""
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        exit_code = 124
        stdout_raw = _coerce_text(exc.stdout)
        stderr_raw = _coerce_text(exc.stderr) + "\nCodex command timed out."

    stdout_text, stdout_truncated = _truncate_text(stdout_raw, max_output_bytes)
    stderr_text, stderr_truncated = _truncate_text(stderr_raw, max_output_bytes)

    if stdout_text.strip():
        append_log(log_path, f"codex_stdout:\n{stdout_text}", logs_dir=logs_dir)
    if stderr_text.strip():
        append_log(log_path, f"codex_stderr:\n{stderr_text}", logs_dir=logs_dir)

    summary_body = (
        "# Codex execution summary\n\n"
        f"- command: `{command_normalized}`\n"
        f"- exit_code: `{exit_code}`\n"
        f"- timed_out: `{timed_out}`\n\n"
        "## stdout\n\n"
        "```\n"
        f"{stdout_text}\n"
        "```\n\n"
        "## stderr\n\n"
        "```\n"
        f"{stderr_text}\n"
        "```\n"
    )
    summary_path.write_text(summary_body, encoding="utf-8")

    diff_saved = False
    try:
        git_diff_argv = validate_command_whitelist(policy, agent, "git diff")
        diff_result = subprocess.run(
            git_diff_argv,
            cwd=str(repo_path),
            shell=False,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        diff_content = diff_result.stdout or ""
        if diff_content.strip():
            diff_path.write_text(diff_content, encoding="utf-8")
            diff_saved = True
    except (PolicyError, OSError):
        diff_saved = False

    workspace_dirty = False
    try:
        git_status_argv = validate_command_whitelist(policy, agent, "git status")
        status_result = subprocess.run(
            [*git_status_argv, "--short"],
            cwd=str(repo_path),
            shell=False,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        workspace_dirty = bool((status_result.stdout or "").strip())
    except (PolicyError, OSError):
        workspace_dirty = False

    manual_required = timed_out or (
        exit_code != 0
        and not _is_recoverable_nonzero_exit(
            stderr_text=stderr_text,
            diff_saved=diff_saved,
            workspace_dirty=workspace_dirty,
        )
    )
    if manual_required:
        reason = (
            "codex non-interactive execution timed out"
            if timed_out
            else f"codex non-interactive exit_code={exit_code}"
        )
        insert_audit_event(
            db_path,
            task_id=task_id,
            actor_type="system",
            actor=worker_user,
            action="codex_manual_required",
            detail={"reason": reason, "run_script": str(run_path)},
        )
        status = "blocked"
        summary = f"BLOCKED: {reason}. Run {run_path}"
        _append_event(
            events_path,
            "codex_manual_required",
            {"reason": reason, "run_script": str(run_path)},
        )
    else:
        status = "succeeded"
        summary = f"SUCCEEDED: codex command completed (exit_code={exit_code})"
    final_message_path.write_text(summary + "\n", encoding="utf-8")

    insert_audit_event(
        db_path,
        task_id=task_id,
        actor_type="agent",
        actor=agent,
        action="codex_result",
        detail={
            "status": status,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "stdout": stdout_text,
            "stderr": stderr_text,
            "stdout_truncated": stdout_truncated,
            "stderr_truncated": stderr_truncated,
            "summary_path": str(summary_path),
            "diff_path": str(diff_path) if diff_saved else None,
            "manual_run_script": str(run_path),
        },
    )
    _append_event(
        events_path,
        "codex_result",
        {
            "status": status,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "manual_required": manual_required,
            "summary": summary,
        },
    )

    return {
        "status": status,
        "summary": summary,
        "exit_code": exit_code,
        "artifacts_dir": str(artifact_dir),
        "manual_required": manual_required,
    }
