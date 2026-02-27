#!/usr/bin/env python3
"""Secure runner worker for ClawBrain."""

from __future__ import annotations

import argparse
import os
import pwd
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from runner.db import create_task, insert_audit_event, update_task_status
from runner.logging import append_log, resolve_log_path
from runner.memory import update_memory
from runner.queue import QueueError, RedisQueue
from runner.skills.codex_skill import run_codex_skill
from shared.policy import (
    PolicyError,
    load_policy,
    normalize_command,
    resolve_repo_path,
    validate_agent,
    validate_command_whitelist,
    validate_paths_write,
    validate_repo_allowed,
    validate_stack,
)

ALLOWED_AGENTS = (
    "TranslatorAgent",
    "PMAgent",
    "MobileAgent",
    "OCRAgent",
    "QAAgent",
    "CoderAgent",
    "BuilderAgent",
    "UXAgent",
    "DeployerAgent",
)
ALLOWED_JOB_TYPES = {"command", "codex"}
DEFAULT_CONFIG_DIR = Path("/data/clawbrain/config")
DEFAULT_DB_PATH = Path("/data/clawbrain/db/clawbrain.sqlite3")
DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"
DEFAULT_QUEUE_NAME = "clawbrain:tasks"
DEFAULT_LOGS_DIR = Path("/data/clawbrain/logs")
DEFAULT_MEMORY_DIR = Path("/data/clawbrain/memory")
DEFAULT_ARTIFACTS_DIR = Path("/data/clawbrain/artifacts")


@dataclass
class JobExecutionResult:
    status: str
    summary: str
    exit_code: int | None
    artifacts_dir: str | None = None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def truncate_text(value: str, max_bytes: int) -> tuple[str, bool]:
    data = value.encode("utf-8")
    if len(data) <= max_bytes:
        return value, False
    truncated = data[:max_bytes].decode("utf-8", errors="ignore")
    return truncated, True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ClawBrain secure worker")
    parser.add_argument("--agent", required=True, choices=ALLOWED_AGENTS)
    parser.add_argument("--once", action="store_true", help="Process at most one job")
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH))
    parser.add_argument("--redis-url", default=os.environ.get("CLAWBRAIN_REDIS_URL", DEFAULT_REDIS_URL))
    parser.add_argument(
        "--queue-name", default=os.environ.get("CLAWBRAIN_QUEUE_NAME", DEFAULT_QUEUE_NAME)
    )
    parser.add_argument("--poll-timeout", type=int, default=5)
    parser.add_argument(
        "--command-timeout",
        type=int,
        default=int(os.environ.get("CLAWBRAIN_COMMAND_TIMEOUT_SEC", "600")),
    )
    parser.add_argument("--max-output-bytes", type=int, default=8192)
    parser.add_argument(
        "--heartbeat-interval",
        type=int,
        default=int(os.environ.get("CLAWBRAIN_HEARTBEAT_INTERVAL_SEC", "10")),
    )
    parser.add_argument(
        "--heartbeat-ttl",
        type=int,
        default=int(os.environ.get("CLAWBRAIN_HEARTBEAT_TTL_SEC", "45")),
    )
    return parser.parse_args()


def _require_str(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise PolicyError(f"missing/invalid payload field '{key}'")
    return value.strip()


def ensure_worker_identity(policy_path: Path, worker_agent: str) -> tuple[Any, str]:
    policy = load_policy(policy_path)
    agent_cfg = validate_agent(policy, worker_agent)

    current_uid = os.geteuid()
    if current_uid == 0:
        raise RuntimeError("worker must never run as root")

    try:
        expected_entry = pwd.getpwnam(agent_cfg.linux_user)
    except KeyError as exc:
        raise RuntimeError(f"linux user not found for {worker_agent}: {agent_cfg.linux_user}") from exc

    if current_uid != expected_entry.pw_uid:
        current_name = pwd.getpwuid(current_uid).pw_name
        raise RuntimeError(
            f"worker user mismatch for {worker_agent}: expected "
            f"{agent_cfg.linux_user}({expected_entry.pw_uid}), got {current_name}({current_uid})"
        )

    return policy, agent_cfg.linux_user


def _safe_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _policy_denied(
    *,
    db_path: Path,
    task_id: str,
    worker_user: str,
    log_path: Path,
    logs_dir: Path,
    reason: str,
    command_raw: str,
) -> JobExecutionResult:
    append_log(log_path, f"policy_denied: {reason}", logs_dir=logs_dir)
    insert_audit_event(
        db_path,
        task_id=task_id,
        actor_type="system",
        actor=worker_user,
        action="policy_denied",
        detail={"reason": reason},
    )
    return JobExecutionResult(
        status="failed",
        summary=f"FAILED: policy_denied command='{command_raw}'",
        exit_code=None,
    )


def _process_command_job(
    *,
    task_id: str,
    repo: str,
    payload_agent: str,
    command_raw: str,
    worker_agent: str,
    policy: Any,
    log_path: Path,
    logs_dir: Path,
    command_timeout: int,
    max_output_bytes: int,
    db_path: Path,
) -> JobExecutionResult:
    if payload_agent != worker_agent:
        raise PolicyError(f"worker for {worker_agent} cannot process task for {payload_agent}")

    if not command_raw.strip():
        raise PolicyError("missing/invalid payload field 'command'")

    validate_agent(policy, payload_agent)
    validate_repo_allowed(policy, repo)
    repo_path = resolve_repo_path(policy, repo)

    argv = validate_command_whitelist(policy, payload_agent, command_raw)
    command_normalized, _ = normalize_command(command_raw)

    insert_audit_event(
        db_path,
        task_id=task_id,
        actor_type="agent",
        actor=worker_agent,
        action="command_run",
        detail={
            "command": command_normalized,
            "argv": argv,
            "cwd": str(repo_path),
            "timeout_sec": command_timeout,
        },
    )
    append_log(log_path, f"command_run: {command_normalized}", logs_dir=logs_dir)

    timed_out = False
    try:
        result = subprocess.run(
            argv,
            cwd=str(repo_path),
            shell=False,
            capture_output=True,
            text=True,
            timeout=command_timeout,
            check=False,
        )
        exit_code = int(result.returncode)
        stdout_raw = result.stdout or ""
        stderr_raw = result.stderr or ""
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        exit_code = 124
        stdout_raw = exc.stdout or ""
        stderr_raw = (exc.stderr or "") + "\nCommand timed out."
    except FileNotFoundError as exc:
        exit_code = 127
        stdout_raw = ""
        stderr_raw = f"Command not found: {argv[0]} ({exc})"
    except OSError as exc:
        exit_code = 126
        stdout_raw = ""
        stderr_raw = f"Command execution failed: {exc}"

    stdout_text, stdout_truncated = truncate_text(stdout_raw, max_output_bytes)
    stderr_text, stderr_truncated = truncate_text(stderr_raw, max_output_bytes)

    if stdout_text.strip():
        append_log(log_path, f"stdout:\n{stdout_text}", logs_dir=logs_dir)
    if stderr_text.strip():
        append_log(log_path, f"stderr:\n{stderr_text}", logs_dir=logs_dir)

    insert_audit_event(
        db_path,
        task_id=task_id,
        actor_type="agent",
        actor=worker_agent,
        action="command_result",
        detail={
            "exit_code": exit_code,
            "timed_out": timed_out,
            "stdout": stdout_text,
            "stderr": stderr_text,
            "stdout_truncated": stdout_truncated,
            "stderr_truncated": stderr_truncated,
        },
    )

    status = "succeeded" if exit_code == 0 and not timed_out else "failed"
    summary = f"{status.upper()}: exit_code={exit_code} command='{command_normalized}'"
    return JobExecutionResult(status=status, summary=summary, exit_code=exit_code)


def _process_codex_job(
    *,
    task_id: str,
    repo: str,
    payload_agent: str,
    request_text: str,
    command_raw: str,
    worker_agent: str,
    worker_user: str,
    policy: Any,
    db_path: Path,
    log_path: Path,
    logs_dir: Path,
    artifacts_dir: Path,
    command_timeout: int,
    max_output_bytes: int,
) -> JobExecutionResult:
    if payload_agent != worker_agent:
        raise PolicyError(f"worker for {worker_agent} cannot process task for {payload_agent}")

    if payload_agent not in {
        "TranslatorAgent",
        "PMAgent",
        "MobileAgent",
        "OCRAgent",
        "QAAgent",
        "CoderAgent",
        "BuilderAgent",
        "UXAgent",
    }:
        raise PolicyError(
            "codex jobs are allowed only for TranslatorAgent, PMAgent, MobileAgent, "
            "OCRAgent, QAAgent, CoderAgent, BuilderAgent, or UXAgent"
        )

    result = run_codex_skill(
        task_id=task_id,
        repo=repo,
        agent=payload_agent,
        request_text=request_text,
        command_raw=command_raw,
        policy=policy,
        db_path=db_path,
        worker_user=worker_user,
        log_path=log_path,
        logs_dir=logs_dir,
        artifacts_root=artifacts_dir,
        command_timeout=command_timeout,
        max_output_bytes=max_output_bytes,
    )
    return JobExecutionResult(
        status=str(result["status"]),
        summary=str(result["summary"]),
        exit_code=result.get("exit_code"),
        artifacts_dir=result.get("artifacts_dir"),
    )


def process_job(
    *,
    job: dict[str, Any],
    worker_agent: str,
    worker_user: str,
    policy: Any,
    default_db_path: Path,
    logs_dir: Path,
    memory_dir: Path,
    artifacts_dir: Path,
    command_timeout: int,
    max_output_bytes: int,
) -> JobExecutionResult:
    task_id = _require_str(job, "task_id")
    repo = _require_str(job, "repo")
    payload_agent = _require_str(job, "agent")
    request_text = _require_str(job, "request_text")
    command_raw = str(job.get("command") or "").strip()
    session_id = job.get("session_id")
    stack = job.get("stack")
    stack_value = stack.strip() if isinstance(stack, str) and stack.strip() else None
    db_path = Path(str(job.get("db_path") or default_db_path)).expanduser()
    job_type = str(job.get("type") or "command").strip().lower()

    if job_type not in ALLOWED_JOB_TYPES:
        raise PolicyError(f"invalid job type '{job_type}', expected one of {sorted(ALLOWED_JOB_TYPES)}")

    command_timeout = _safe_int(job.get("timeout_sec"), command_timeout)
    max_output_bytes = _safe_int(job.get("max_output_bytes"), max_output_bytes)

    log_path = resolve_log_path(task_id, logs_dir=logs_dir)
    append_log(
        log_path,
        f"task_received type={job_type} agent={payload_agent} repo={repo}",
        logs_dir=logs_dir,
    )

    create_task(
        db_path,
        task_id=task_id,
        session_id=session_id if isinstance(session_id, str) else None,
        repo=repo,
        agent=payload_agent,
        status="queued",
        request_text=request_text,
        log_path=str(log_path),
    )
    update_task_status(db_path, task_id=task_id, status="running", started_at=utc_now_iso())

    try:
        validate_paths_write(policy, log_path)
        validate_paths_write(policy, memory_dir.resolve() / f"{repo}.md")
        if stack_value:
            validate_stack(policy, stack_value)

        if job_type == "command":
            result = _process_command_job(
                task_id=task_id,
                repo=repo,
                payload_agent=payload_agent,
                command_raw=command_raw,
                worker_agent=worker_agent,
                policy=policy,
                log_path=log_path,
                logs_dir=logs_dir,
                command_timeout=command_timeout,
                max_output_bytes=max_output_bytes,
                db_path=db_path,
            )
        else:
            validate_paths_write(policy, artifacts_dir.resolve())
            result = _process_codex_job(
                task_id=task_id,
                repo=repo,
                payload_agent=payload_agent,
                request_text=request_text,
                command_raw=command_raw,
                worker_agent=worker_agent,
                worker_user=worker_user,
                policy=policy,
                db_path=db_path,
                log_path=log_path,
                logs_dir=logs_dir,
                artifacts_dir=artifacts_dir,
                command_timeout=command_timeout,
                max_output_bytes=max_output_bytes,
            )
    except PolicyError as exc:
        result = _policy_denied(
            db_path=db_path,
            task_id=task_id,
            worker_user=worker_user,
            log_path=log_path,
            logs_dir=logs_dir,
            reason=str(exc),
            command_raw=command_raw,
        )
    except Exception as exc:  # noqa: BLE001
        append_log(log_path, f"execution_failed: {exc}", logs_dir=logs_dir)
        insert_audit_event(
            db_path,
            task_id=task_id,
            actor_type="system",
            actor=worker_user,
            action="execution_failed",
            detail={"error": str(exc)},
        )
        result = JobExecutionResult(
            status="failed",
            summary=f"FAILED: execution_error={exc}",
            exit_code=None,
        )

    final_result = result
    try:
        memory_path, content_hash = update_memory(
            repo,
            result.summary,
            db_path=db_path,
            memory_dir=memory_dir,
        )
        insert_audit_event(
            db_path,
            task_id=task_id,
            actor_type="agent",
            actor=worker_agent,
            action="memory_updated",
            detail={"memory_path": str(memory_path), "content_hash": content_hash},
        )
        append_log(log_path, f"memory_updated: {memory_path}", logs_dir=logs_dir)
    except Exception as exc:  # noqa: BLE001
        insert_audit_event(
            db_path,
            task_id=task_id,
            actor_type="system",
            actor=worker_user,
            action="memory_update_failed",
            detail={"error": str(exc)},
        )
        append_log(log_path, f"memory_update_failed: {exc}", logs_dir=logs_dir)
        final_result = JobExecutionResult(
            status="failed",
            summary=f"FAILED: {result.summary} memory_error={exc}",
            exit_code=result.exit_code,
            artifacts_dir=result.artifacts_dir,
        )

    update_task_status(
        db_path,
        task_id=task_id,
        status=final_result.status,
        finished_at=utc_now_iso(),
        exit_code=final_result.exit_code,
        summary_text=final_result.summary,
        log_path=str(log_path),
        artifacts_dir=final_result.artifacts_dir,
    )
    append_log(
        log_path,
        f"task_finished status={final_result.status} exit_code={final_result.exit_code}",
        logs_dir=logs_dir,
    )
    return final_result


def main() -> int:
    args = parse_args()
    logs_dir = Path(os.environ.get("CLAWBRAIN_LOGS_DIR", str(DEFAULT_LOGS_DIR))).resolve()
    memory_dir = Path(os.environ.get("CLAWBRAIN_MEMORY_DIR", str(DEFAULT_MEMORY_DIR))).resolve()
    artifacts_dir = Path(
        os.environ.get("CLAWBRAIN_ARTIFACTS_DIR", str(DEFAULT_ARTIFACTS_DIR))
    ).resolve()
    config_dir = Path(os.environ.get("CLAWBRAIN_CONFIG_DIR", str(DEFAULT_CONFIG_DIR))).resolve()
    policy_path = config_dir / "policy.yaml"
    default_db_path = Path(args.db_path).expanduser()

    try:
        policy, worker_user = ensure_worker_identity(policy_path, args.agent)
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] worker startup validation failed: {exc}")
        return 1

    queue = RedisQueue(redis_url=args.redis_url, queue_name=args.queue_name)
    try:
        queue.ping()
    except QueueError as exc:
        print(f"[FAIL] queue unavailable: {exc}")
        return 1

    print(
        f"[INFO] worker ready agent={args.agent} user={worker_user} queue={args.queue_name}"
    )
    last_heartbeat = 0.0

    def maybe_publish_heartbeat(state: str) -> None:
        nonlocal last_heartbeat
        now = time.monotonic()
        if now - last_heartbeat < max(2, args.heartbeat_interval):
            return
        try:
            queue.publish_heartbeat(
                agent=args.agent,
                linux_user=worker_user,
                ttl_seconds=max(15, args.heartbeat_ttl),
                extra={"state": state},
            )
            last_heartbeat = now
        except QueueError as exc:
            print(f"[WARN] heartbeat publish failed: {exc}")

    while True:
        maybe_publish_heartbeat("idle")
        try:
            job = queue.dequeue(timeout=args.poll_timeout)
        except QueueError as exc:
            print(f"[FAIL] dequeue error: {exc}")
            return 1

        if job is None:
            if args.once:
                print("[FAIL] --once set but no job available")
                return 1
            continue

        payload_agent = str(job.get("agent") or "").strip()
        if payload_agent and payload_agent != args.agent:
            maybe_publish_heartbeat("requeue")
            try:
                queue.enqueue(job)
            except QueueError as exc:
                print(f"[FAIL] failed to requeue task for agent {payload_agent}: {exc}")
                return 1
            print(
                f"[INFO] requeued task {job.get('task_id', '<unknown>')} for "
                f"agent={payload_agent} (worker agent={args.agent})"
            )
            if args.once:
                print(
                    f"[FAIL] --once worker for {args.agent} received task for {payload_agent}"
                )
                return 1
            continue

        maybe_publish_heartbeat("running")
        result = process_job(
            job=job,
            worker_agent=args.agent,
            worker_user=worker_user,
            policy=policy,
            default_db_path=default_db_path,
            logs_dir=logs_dir,
            memory_dir=memory_dir,
            artifacts_dir=artifacts_dir,
            command_timeout=args.command_timeout,
            max_output_bytes=args.max_output_bytes,
        )
        maybe_publish_heartbeat("idle")

        if args.once:
            return 0 if result.status in {"succeeded", "blocked"} else 1

        if result.status not in {"succeeded", "blocked"}:
            print(f"[WARN] task failed with status={result.status}")


if __name__ == "__main__":
    raise SystemExit(main())
