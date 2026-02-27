#!/usr/bin/env python3
"""Minimal MCP stdio server exposing ClawBrain tools."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from ide_client.client import ClawBrainIDEClient, IDEClientError, apply_patch_local
from ide_client.config import ConfigError, load_config
from ide_client.pm_orchestrator import (
    PMOrchestratorError,
    build_interview_from_payload,
    build_pm_plan,
    dispatch_pm_plan,
    translate_simple_request,
)


class MCPProtocolError(RuntimeError):
    """Raised for malformed MCP messages."""


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=True)


def _read_message(stdin: Any) -> dict[str, Any] | None:
    headers: dict[str, str] = {}

    while True:
        line = stdin.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        decoded = line.decode("utf-8", errors="replace").strip()
        if not decoded:
            break
        if ":" not in decoded:
            continue
        key, value = decoded.split(":", 1)
        headers[key.strip().lower()] = value.strip()

    if "content-length" not in headers:
        raise MCPProtocolError("missing Content-Length header")

    try:
        content_length = int(headers["content-length"])
    except ValueError as exc:
        raise MCPProtocolError("invalid Content-Length header") from exc

    body = stdin.read(content_length)
    if len(body) != content_length:
        raise MCPProtocolError("unexpected EOF while reading body")

    try:
        parsed = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise MCPProtocolError(f"invalid JSON message: {exc}") from exc

    if not isinstance(parsed, dict):
        raise MCPProtocolError("JSON-RPC payload must be an object")
    return parsed


def _write_message(stdout: Any, payload: dict[str, Any]) -> None:
    body = _json_dumps(payload).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    stdout.write(header)
    stdout.write(body)
    stdout.flush()


def _tool_list() -> list[dict[str, Any]]:
    return [
        {
            "name": "clawbrain.create_task",
            "description": "Create an IDE task on ClawBrain server",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["command", "codex"], "default": "codex"},
                    "repo": {"type": "string"},
                    "agent": {"type": "string"},
                    "request_text": {"type": "string"},
                    "command": {"type": "string"},
                    "prompt": {"type": "string"},
                    "constraints": {"type": "object"},
                },
                "required": ["repo", "agent", "request_text"],
            },
        },
        {
            "name": "clawbrain.get_task",
            "description": "Get a task from IDE API",
            "inputSchema": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
        {
            "name": "clawbrain.get_logs",
            "description": "Fetch task logs",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "max_bytes": {"type": "integer", "default": 8192},
                },
                "required": ["task_id"],
            },
        },
        {
            "name": "clawbrain.get_diff",
            "description": "Download task diff.patch",
            "inputSchema": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        },
        {
            "name": "clawbrain.list_agents",
            "description": "List available agents",
            "inputSchema": {"type": "object", "properties": {}},
        },
        {
            "name": "clawbrain.apply_patch_local",
            "description": "Apply patch on local git workspace with explicit confirmation",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "patch_path": {"type": "string"},
                    "repo_path": {"type": "string", "default": "."},
                    "yes": {"type": "boolean", "default": False},
                    "index": {"type": "boolean", "default": False},
                },
                "required": ["patch_path"],
            },
        },
        {
            "name": "clawbrain.pm_plan",
            "description": "Build PM interview plan and translated task breakdown",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string"},
                    "goal": {"type": "string"},
                    "current_state": {"type": "string"},
                    "deliverables": {"type": "string"},
                    "constraints": {"type": "string"},
                    "definition_done": {"type": "string"},
                    "priority": {"type": "string", "enum": ["critical", "high", "normal", "low"]},
                    "needs_ux": {"type": "string", "enum": ["auto", "yes", "no"]},
                    "needs_builder": {"type": "string", "enum": ["auto", "yes", "no"]},
                },
                "required": ["repo", "goal"],
            },
        },
        {
            "name": "clawbrain.pm_dispatch",
            "description": "Build PM plan and dispatch translated tasks to execution agents",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string"},
                    "goal": {"type": "string"},
                    "current_state": {"type": "string"},
                    "deliverables": {"type": "string"},
                    "constraints": {"type": "string"},
                    "definition_done": {"type": "string"},
                    "priority": {"type": "string", "enum": ["critical", "high", "normal", "low"]},
                    "needs_ux": {"type": "string", "enum": ["auto", "yes", "no"]},
                    "needs_builder": {"type": "string", "enum": ["auto", "yes", "no"]},
                },
                "required": ["repo", "goal"],
            },
        },
        {
            "name": "clawbrain.pm_translate_simple",
            "description": "Translate a simple user phrase to PM interview payload and plan",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string"},
                    "text": {"type": "string"},
                    "priority": {"type": "string", "enum": ["critical", "high", "normal", "low"]},
                    "needs_ux": {"type": "string", "enum": ["auto", "yes", "no"]},
                    "needs_builder": {"type": "string", "enum": ["auto", "yes", "no"]},
                },
                "required": ["repo", "text"],
            },
        },
        {
            "name": "clawbrain.pm_translate_and_dispatch_simple",
            "description": "Translate simple phrase to PM plan and dispatch tasks",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string"},
                    "text": {"type": "string"},
                    "priority": {"type": "string", "enum": ["critical", "high", "normal", "low"]},
                    "needs_ux": {"type": "string", "enum": ["auto", "yes", "no"]},
                    "needs_builder": {"type": "string", "enum": ["auto", "yes", "no"]},
                },
                "required": ["repo", "text"],
            },
        },
    ]


def _result_text(payload: Any) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": _json_dumps(payload)}],
    }


def _error_text(message: str) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": message}],
        "isError": True,
    }


def _build_client() -> ClawBrainIDEClient:
    cfg = load_config(require_token=True)
    return ClawBrainIDEClient(cfg)


def _pm_payload(args: dict[str, Any]) -> dict[str, Any]:
    return {
        "repo": str(args.get("repo", "")).strip(),
        "goal": str(args.get("goal") or args.get("request_text") or "").strip(),
        "current_state": str(args.get("current_state", "")).strip(),
        "deliverables": str(args.get("deliverables", "")).strip(),
        "constraints": str(args.get("constraints", "")).strip(),
        "definition_done": str(args.get("definition_done", "")).strip(),
        "priority": str(args.get("priority", "")).strip(),
        "needs_ux": str(args.get("needs_ux", "")).strip(),
        "needs_builder": str(args.get("needs_builder", "")).strip(),
    }


def _simple_pm_payload(args: dict[str, Any]) -> dict[str, Any]:
    return {
        "repo": str(args.get("repo", "")).strip(),
        "text": str(args.get("text") or args.get("request_text") or "").strip(),
        "priority": str(args.get("priority", "")).strip(),
        "needs_ux": str(args.get("needs_ux", "")).strip(),
        "needs_builder": str(args.get("needs_builder", "")).strip(),
    }


def _tool_call(name: str, args: dict[str, Any], client: ClawBrainIDEClient) -> dict[str, Any]:
    if name == "clawbrain.create_task":
        payload = {
            "type": str(args.get("type", "codex")),
            "repo": str(args.get("repo", "")).strip(),
            "agent": str(args.get("agent", "")).strip(),
            "request_text": str(args.get("request_text", "")).strip(),
            "command": args.get("command"),
            "prompt": args.get("prompt"),
            "constraints": args.get("constraints") if isinstance(args.get("constraints"), dict) else {},
        }
        return _result_text(client.create_task(payload))

    if name == "clawbrain.get_task":
        task_id = str(args.get("task_id", "")).strip()
        return _result_text(client.get_task(task_id))

    if name == "clawbrain.get_logs":
        task_id = str(args.get("task_id", "")).strip()
        max_bytes = int(args.get("max_bytes", 8192))
        return _result_text(client.get_logs(task_id, max_bytes=max_bytes))

    if name == "clawbrain.get_diff":
        task_id = str(args.get("task_id", "")).strip()
        diff = client.get_diff(task_id)
        return {"content": [{"type": "text", "text": diff}]}

    if name == "clawbrain.list_agents":
        return _result_text(client.list_agents())

    if name == "clawbrain.apply_patch_local":
        patch_path = Path(str(args.get("patch_path", "")).strip())
        repo_path = Path(str(args.get("repo_path", ".")).strip() or ".")
        yes = bool(args.get("yes", False))
        index = bool(args.get("index", False))
        result = apply_patch_local(patch_path=patch_path, repo_path=repo_path, yes=yes, index=index)
        return _result_text(result)

    if name == "clawbrain.pm_plan":
        interview = build_interview_from_payload(_pm_payload(args))
        plan = build_pm_plan(interview)
        return _result_text({"plan": plan.as_dict()})

    if name == "clawbrain.pm_dispatch":
        interview = build_interview_from_payload(_pm_payload(args))
        plan = build_pm_plan(interview)
        dispatch = dispatch_pm_plan(plan=plan, create_task=client.create_task)
        return _result_text({"plan": plan.as_dict(), "dispatch": dispatch})

    if name == "clawbrain.pm_translate_simple":
        payload = _simple_pm_payload(args)
        translation = translate_simple_request(
            repo=payload["repo"],
            text=payload["text"],
            priority=payload["priority"] or None,
            needs_ux=payload["needs_ux"] or None,
            needs_builder=payload["needs_builder"] or None,
        )
        interview = build_interview_from_payload(translation.interview_payload)
        plan = build_pm_plan(interview)
        return _result_text({"translation": translation.as_dict(), "plan": plan.as_dict()})

    if name == "clawbrain.pm_translate_and_dispatch_simple":
        payload = _simple_pm_payload(args)
        translation = translate_simple_request(
            repo=payload["repo"],
            text=payload["text"],
            priority=payload["priority"] or None,
            needs_ux=payload["needs_ux"] or None,
            needs_builder=payload["needs_builder"] or None,
        )
        interview = build_interview_from_payload(translation.interview_payload)
        plan = build_pm_plan(interview)
        dispatch = dispatch_pm_plan(plan=plan, create_task=client.create_task)
        return _result_text(
            {"translation": translation.as_dict(), "plan": plan.as_dict(), "dispatch": dispatch}
        )

    raise IDEClientError(f"unknown tool: {name}")


def _handle_request(msg: dict[str, Any], client: ClawBrainIDEClient) -> dict[str, Any] | None:
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "clawbrain-mcp", "version": "0.1.0"},
                "instructions": "Use clawbrain.* tools to orchestrate tasks and local patch apply.",
            },
        }

    if method == "notifications/initialized":
        return None

    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": _tool_list()},
        }

    if method == "tools/call":
        tool_name = str(params.get("name", "")).strip()
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            result = _tool_call(tool_name, args, client)
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except (IDEClientError, ConfigError, PMOrchestratorError, ValueError) as exc:
            return {"jsonrpc": "2.0", "id": req_id, "result": _error_text(str(exc))}

    if req_id is None:
        return None

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> int:
    try:
        client = _build_client()
    except (ConfigError, IDEClientError) as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    while True:
        try:
            msg = _read_message(stdin)
        except MCPProtocolError as exc:
            error_payload = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": str(exc)},
            }
            _write_message(stdout, error_payload)
            continue

        if msg is None:
            return 0

        response = _handle_request(msg, client)
        if response is not None:
            _write_message(stdout, response)


if __name__ == "__main__":
    raise SystemExit(main())
