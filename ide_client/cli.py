#!/usr/bin/env python3
"""CLI gateway for ClawBrain IDE integration."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ide_client.client import ClawBrainIDEClient, IDEClientError, apply_patch_local
from ide_client.config import ConfigError, load_config, save_config
from ide_client.pm_orchestrator import (
    PMOrchestratorError,
    build_interview_from_payload,
    build_pm_plan,
    dispatch_pm_plan,
    translate_simple_request,
)


def _json_dump(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True))


def _client() -> ClawBrainIDEClient:
    cfg = load_config(require_token=True)
    return ClawBrainIDEClient(cfg)


def cmd_config_show(_: argparse.Namespace) -> int:
    cfg = load_config(require_token=False)
    payload = {
        "config_path": str(cfg.config_path),
        "server_url": cfg.server_url,
        "token_configured": bool(cfg.token),
        "timeout_sec": cfg.timeout_sec,
    }
    _json_dump(payload)
    return 0


def cmd_config_set(args: argparse.Namespace) -> int:
    path = save_config(server_url=args.server_url, token=args.token, timeout_sec=args.timeout_sec)
    print(f"saved config: {path}")
    return 0


def cmd_agents(_: argparse.Namespace) -> int:
    _json_dump(_client().list_agents())
    return 0


def cmd_create_task(args: argparse.Namespace) -> int:
    constraints: dict[str, Any] = {}
    if args.constraints_json:
        try:
            parsed = json.loads(args.constraints_json)
        except json.JSONDecodeError as exc:
            raise IDEClientError(f"invalid --constraints-json: {exc}") from exc
        if not isinstance(parsed, dict):
            raise IDEClientError("--constraints-json must decode to a JSON object")
        constraints = parsed

    payload = {
        "type": args.type,
        "repo": args.repo,
        "agent": args.agent,
        "request_text": args.request_text,
        "prompt": args.prompt,
        "command": args.command,
        "constraints": constraints,
    }
    _json_dump(_client().create_task(payload))
    return 0


def cmd_get_task(args: argparse.Namespace) -> int:
    _json_dump(_client().get_task(args.task_id))
    return 0


def cmd_wait_task(args: argparse.Namespace) -> int:
    success = {value.strip() for value in args.success_statuses.split(",") if value.strip()}
    errors = {value.strip() for value in args.error_statuses.split(",") if value.strip()}
    payload = _client().wait_task(
        args.task_id,
        timeout_sec=args.timeout_sec,
        poll_interval_sec=args.poll_interval_sec,
        success_statuses=success,
        error_statuses=errors,
    )
    _json_dump(payload)
    return 0


def cmd_get_logs(args: argparse.Namespace) -> int:
    _json_dump(_client().get_logs(args.task_id, max_bytes=args.max_bytes))
    return 0


def cmd_get_diff(args: argparse.Namespace) -> int:
    diff = _client().get_diff(args.task_id)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(diff, encoding="utf-8")
        print(f"saved diff: {path}")
        return 0
    print(diff)
    return 0


def cmd_list_artifacts(args: argparse.Namespace) -> int:
    _json_dump(_client().list_artifacts(args.task_id))
    return 0


def cmd_get_artifact(args: argparse.Namespace) -> int:
    raw = _client().get_artifact(args.task_id, args.name)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        print(f"saved artifact: {path}")
        return 0

    try:
        print(raw.decode("utf-8"))
    except UnicodeDecodeError:
        print(f"<binary {len(raw)} bytes>")
    return 0


def cmd_apply_patch_local(args: argparse.Namespace) -> int:
    result = apply_patch_local(
        patch_path=Path(args.patch),
        repo_path=Path(args.repo),
        yes=args.yes,
        index=args.index,
    )
    _json_dump(result)
    return 0


def _dispatch_or_cancel(
    *,
    plan_output: dict[str, Any],
    plan: Any,
    yes: bool,
    dry_run: bool,
    interactive: bool,
) -> int:
    if dry_run:
        _json_dump(plan_output)
        return 0

    if not yes:
        if not interactive:
            raise IDEClientError("non-interactive mode requires --yes or --dry-run")
        print("")
        print(plan.summary)
        for task in plan.tasks:
            print(f"- {task.order}. {task.agent}: {task.reason}")
        confirm = input("Despachar tareas ahora? [y/N]: ").strip().lower()
        if confirm not in {"y", "yes", "s", "si"}:
            plan_output["dispatch"] = {
                "summary": "dispatch_cancelled",
                "queued_count": 0,
                "failed_count": 0,
                "queued": [],
                "failed": [],
            }
            _json_dump(plan_output)
            return 0

    dispatch = dispatch_pm_plan(plan=plan, create_task=_client().create_task)
    plan_output["dispatch"] = dispatch
    _json_dump(plan_output)
    return 0 if int(dispatch.get("failed_count", 0)) == 0 else 1


def _prompt_text(
    *,
    question: str,
    default: str | None = None,
    required: bool = False,
) -> str:
    while True:
        suffix = f" [{default}]" if isinstance(default, str) and default.strip() else ""
        answer = input(f"{question}{suffix}: ").strip()
        if not answer and isinstance(default, str):
            answer = default.strip()
        if required and not answer:
            print("Campo requerido.")
            continue
        return answer


def _resolve_pm_field(
    *,
    value: str | None,
    question: str,
    default: str | None,
    required: bool,
    interactive: bool,
) -> str:
    cleaned = value.strip() if isinstance(value, str) else ""
    if cleaned:
        return cleaned
    if interactive:
        return _prompt_text(question=question, default=default, required=required)
    if required:
        raise IDEClientError(f"missing required field in non-interactive mode: {question}")
    return (default or "").strip()


def cmd_pm_run(args: argparse.Namespace) -> int:
    interactive = (not args.non_interactive) and sys.stdin.isatty()

    payload = {
        "repo": _resolve_pm_field(
            value=args.repo,
            question="Repo objetivo",
            default=None,
            required=True,
            interactive=interactive,
        ),
        "goal": _resolve_pm_field(
            value=args.goal,
            question="Objetivo principal",
            default=None,
            required=True,
            interactive=interactive,
        ),
        "current_state": _resolve_pm_field(
            value=args.current_state,
            question="Estado actual o problema",
            default="No contexto tecnico adicional del usuario.",
            required=False,
            interactive=interactive,
        ),
        "deliverables": _resolve_pm_field(
            value=args.deliverables,
            question="Entregables esperados",
            default="Cambios en codigo mas resumen corto de implementacion.",
            required=False,
            interactive=interactive,
        ),
        "constraints": _resolve_pm_field(
            value=args.constraints,
            question="Restricciones o limites",
            default="No romper comportamiento existente. Cambios minimos y revisables.",
            required=False,
            interactive=interactive,
        ),
        "definition_done": _resolve_pm_field(
            value=args.definition_done,
            question="Definicion de terminado",
            default="Implementado, validado y documentado en resumen final.",
            required=False,
            interactive=interactive,
        ),
        "priority": _resolve_pm_field(
            value=args.priority,
            question="Prioridad (critical|high|normal|low)",
            default="normal",
            required=False,
            interactive=interactive,
        ),
        "needs_ux": _resolve_pm_field(
            value=args.needs_ux,
            question="Incluir UXAgent? (auto|yes|no)",
            default="auto",
            required=False,
            interactive=interactive,
        ),
        "needs_builder": _resolve_pm_field(
            value=args.needs_builder,
            question="Incluir BuilderAgent? (auto|yes|no)",
            default="auto",
            required=False,
            interactive=interactive,
        ),
    }

    interview = build_interview_from_payload(payload)
    plan = build_pm_plan(interview)
    output: dict[str, Any] = {"plan": plan.as_dict()}
    return _dispatch_or_cancel(
        plan_output=output,
        plan=plan,
        yes=bool(args.yes),
        dry_run=bool(args.dry_run),
        interactive=interactive,
    )


def cmd_pm_simple(args: argparse.Namespace) -> int:
    interactive = (not args.non_interactive) and sys.stdin.isatty()
    repo = _resolve_pm_field(
        value=args.repo,
        question="Repo objetivo",
        default=None,
        required=True,
        interactive=interactive,
    )
    text = _resolve_pm_field(
        value=args.text,
        question="Explicalo en palabras simples",
        default=None,
        required=True,
        interactive=interactive,
    )

    translation = translate_simple_request(
        repo=repo,
        text=text,
        priority=args.priority,
        needs_ux=args.needs_ux,
        needs_builder=args.needs_builder,
    )
    interview = build_interview_from_payload(translation.interview_payload)
    plan = build_pm_plan(interview)
    output: dict[str, Any] = {
        "translation": translation.as_dict(),
        "plan": plan.as_dict(),
    }
    return _dispatch_or_cancel(
        plan_output=output,
        plan=plan,
        yes=bool(args.yes),
        dry_run=bool(args.dry_run),
        interactive=interactive,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ClawBrain IDE local gateway CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_config_show = sub.add_parser("config-show", help="Show resolved configuration")
    p_config_show.set_defaults(func=cmd_config_show)

    p_config_set = sub.add_parser("config-set", help="Store local configuration")
    p_config_set.add_argument("--server-url")
    p_config_set.add_argument("--token")
    p_config_set.add_argument("--timeout-sec", type=int)
    p_config_set.set_defaults(func=cmd_config_set)

    p_agents = sub.add_parser("agents", help="List IDE agents")
    p_agents.set_defaults(func=cmd_agents)

    p_create = sub.add_parser("create-task", help="Create IDE task")
    p_create.add_argument("--type", choices=("command", "codex"), default="codex")
    p_create.add_argument("--repo", required=True)
    p_create.add_argument("--agent", required=True)
    p_create.add_argument("--request-text", required=True)
    p_create.add_argument("--command")
    p_create.add_argument("--prompt")
    p_create.add_argument("--constraints-json")
    p_create.set_defaults(func=cmd_create_task)

    p_get_task = sub.add_parser("get-task", help="Get IDE task")
    p_get_task.add_argument("task_id")
    p_get_task.set_defaults(func=cmd_get_task)

    p_wait = sub.add_parser("wait-task", help="Wait until task reaches terminal status")
    p_wait.add_argument("task_id")
    p_wait.add_argument("--timeout-sec", type=int, default=180)
    p_wait.add_argument("--poll-interval-sec", type=float, default=2.0)
    p_wait.add_argument("--success-statuses", default="succeeded,blocked")
    p_wait.add_argument("--error-statuses", default="failed,canceled")
    p_wait.set_defaults(func=cmd_wait_task)

    p_logs = sub.add_parser("get-logs", help="Fetch task logs")
    p_logs.add_argument("task_id")
    p_logs.add_argument("--max-bytes", type=int, default=8192)
    p_logs.set_defaults(func=cmd_get_logs)

    p_diff = sub.add_parser("get-diff", help="Fetch task diff.patch")
    p_diff.add_argument("task_id")
    p_diff.add_argument("--output")
    p_diff.set_defaults(func=cmd_get_diff)

    p_list_artifacts = sub.add_parser("list-artifacts", help="List task artifacts")
    p_list_artifacts.add_argument("task_id")
    p_list_artifacts.set_defaults(func=cmd_list_artifacts)

    p_get_artifact = sub.add_parser("get-artifact", help="Download specific task artifact")
    p_get_artifact.add_argument("task_id")
    p_get_artifact.add_argument("name")
    p_get_artifact.add_argument("--output")
    p_get_artifact.set_defaults(func=cmd_get_artifact)

    p_apply = sub.add_parser("apply-patch-local", help="Apply patch locally with confirmation")
    p_apply.add_argument("--patch", required=True)
    p_apply.add_argument("--repo", default=".")
    p_apply.add_argument("--yes", action="store_true")
    p_apply.add_argument("--index", action="store_true")
    p_apply.set_defaults(func=cmd_apply_patch_local)

    p_pm = sub.add_parser("pm-run", help="Interview -> plan -> dispatch tasks as PM agent")
    p_pm.add_argument("--repo")
    p_pm.add_argument("--goal", "--request-text", dest="goal")
    p_pm.add_argument("--current-state")
    p_pm.add_argument("--deliverables")
    p_pm.add_argument("--constraints")
    p_pm.add_argument("--definition-done")
    p_pm.add_argument("--priority")
    p_pm.add_argument("--needs-ux")
    p_pm.add_argument("--needs-builder")
    p_pm.add_argument("--dry-run", action="store_true")
    p_pm.add_argument("--yes", action="store_true")
    p_pm.add_argument("--non-interactive", action="store_true")
    p_pm.set_defaults(func=cmd_pm_run)

    p_pm_simple = sub.add_parser(
        "pm-simple",
        help="Translate simple words into PM plan and dispatch tasks",
    )
    p_pm_simple.add_argument("--repo")
    p_pm_simple.add_argument("--text", "--request-text", dest="text")
    p_pm_simple.add_argument("--priority")
    p_pm_simple.add_argument("--needs-ux")
    p_pm_simple.add_argument("--needs-builder")
    p_pm_simple.add_argument("--dry-run", action="store_true")
    p_pm_simple.add_argument("--yes", action="store_true")
    p_pm_simple.add_argument("--non-interactive", action="store_true")
    p_pm_simple.set_defaults(func=cmd_pm_simple)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        return int(args.func(args))
    except (ConfigError, IDEClientError, PMOrchestratorError) as exc:
        print(f"[FAIL] {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
