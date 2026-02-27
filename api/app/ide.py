#!/usr/bin/env python3
"""IDE-oriented API endpoints for ClawBrain."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import PlainTextResponse

from api.app.auth import require_auth
from api.app.models import (
    ArtifactItem,
    IdeApplyInstructions,
    IdeArtifactsListResponse,
    IdeTaskCreateRequest,
    IdeTaskCreateResponse,
    IdeTaskResponse,
)
from api.app.storage import ensure_path_under, get_settings, get_task_row, read_policy_or_error
from runner.db import create_task, insert_audit_event
from runner.logging import resolve_log_path
from runner.queue import QueueError, RedisQueue
from shared.policy import (
    PolicyError,
    resolve_repo_path,
    validate_agent,
    validate_command_whitelist,
    validate_repo_allowed,
)

router = APIRouter(tags=["ide"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _policy_error_to_http(exc: Exception) -> HTTPException:
    if isinstance(exc, PolicyError):
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))


def _build_apply_instructions(task_id: str) -> IdeApplyInstructions:
    return IdeApplyInstructions(
        mode="manual_confirm",
        steps=[
            f"Descarga artifacts y diff desde /api/ide/tasks/{task_id}/artifacts y /api/ide/tasks/{task_id}/diff",
            "Revisa el patch en tu IDE local",
            "Aplica cambios localmente con confirmacion explicita (ej: git apply diff.patch)",
        ],
    )


def _load_agents_catalog(config_dir: Path) -> dict[str, dict[str, Any]]:
    path = config_dir / "agents.yaml"
    if not path.is_file():
        return {}
    try:
        payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}

    agents_block = payload.get("agents")
    if not isinstance(agents_block, dict):
        return {}

    catalog: dict[str, dict[str, Any]] = {}
    for name, value in agents_block.items():
        if isinstance(name, str) and isinstance(value, dict):
            catalog[name] = value
    return catalog


def _resolve_artifacts_dir(task_id: str, artifacts_dir_raw: str | None) -> Path | None:
    if not artifacts_dir_raw:
        return None

    settings = get_settings()
    artifacts_dir = ensure_path_under(settings.artifacts_dir, Path(artifacts_dir_raw))
    if not artifacts_dir.exists():
        return None
    if not artifacts_dir.is_dir():
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="invalid artifacts_dir")
    return artifacts_dir


def _list_artifact_items(artifacts_dir: Path | None) -> list[ArtifactItem]:
    if artifacts_dir is None:
        return []

    items: list[ArtifactItem] = []
    for path in sorted(artifacts_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(artifacts_dir).as_posix()
        items.append(ArtifactItem(name=rel, size_bytes=path.stat().st_size))
    return items


@router.get("/agents", dependencies=[Depends(require_auth)])
def ide_list_agents() -> dict[str, list[dict[str, Any]]]:
    settings = get_settings()
    policy = read_policy_or_error(settings)
    catalog = _load_agents_catalog(settings.config_dir)

    output: list[dict[str, Any]] = []
    for agent_name in sorted(policy.agents.keys()):
        policy_cfg = policy.agents[agent_name]
        extra = catalog.get(agent_name, {})
        output.append(
            {
                "name": agent_name,
                "linux_user": policy_cfg.linux_user,
                "allow_sudo": bool(policy_cfg.allow_sudo),
                "role": str(extra.get("role", "")),
                "description": str(extra.get("description", "")),
                "model": str(extra.get("model", "")),
                "skills": extra.get("skills", []),
            }
        )

    return {"agents": output}


@router.post("/tasks", response_model=IdeTaskCreateResponse, dependencies=[Depends(require_auth)])
def ide_create_task(payload: IdeTaskCreateRequest) -> IdeTaskCreateResponse:
    settings = get_settings()
    try:
        policy = read_policy_or_error(settings)
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc

    repo = payload.repo
    agent = payload.agent
    request_text = payload.request_text or payload.prompt or ""
    command = payload.command

    try:
        validate_agent(policy, agent)
        validate_repo_allowed(policy, repo)
        repo_path = resolve_repo_path(policy, repo)

        if payload.type == "command":
            if not command:
                raise PolicyError("command is required when type=command")
            validate_command_whitelist(policy, agent, command)
        else:
            if not command:
                command = (
                    f"codex exec --skip-git-repo-check --sandbox workspace-write "
                    f"-C {repo_path} -"
                )
            validate_command_whitelist(policy, agent, command)
    except Exception as exc:
        raise _policy_error_to_http(exc) from exc

    task_id = str(uuid.uuid4())
    created_at = _now_iso()
    log_path = resolve_log_path(task_id, logs_dir=settings.logs_dir)

    payload_to_queue = {
        "task_id": task_id,
        "type": payload.type,
        "origin": "ide",
        "repo": repo,
        "agent": agent,
        "command": command,
        "request_text": request_text,
        "prompt": payload.prompt,
        "constraints": payload.constraints,
        "db_path": str(settings.db_path),
        "created_at": created_at,
    }

    try:
        create_task(
            settings.db_path,
            task_id=task_id,
            session_id=None,
            repo=repo,
            agent=agent,
            status="queued",
            request_text=request_text,
            log_path=str(log_path),
            created_at=created_at,
        )
        insert_audit_event(
            settings.db_path,
            task_id=task_id,
            actor_type="user",
            actor="ide_client",
            action="ide_task_created",
            detail={
                "type": payload.type,
                "repo": repo,
                "agent": agent,
                "origin": "ide",
            },
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"failed to create task in DB: {exc}",
        ) from exc

    queue = RedisQueue(redis_url=settings.redis_url, queue_name=settings.queue_name)
    try:
        queue.ping()
        queue.enqueue(payload_to_queue)
    except QueueError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"failed to enqueue task: {exc}",
        ) from exc

    return IdeTaskCreateResponse(
        task_id=task_id,
        status="queued",
        apply_instructions=_build_apply_instructions(task_id),
    )


@router.get("/tasks/{task_id}", response_model=IdeTaskResponse, dependencies=[Depends(require_auth)])
def ide_get_task(task_id: str) -> IdeTaskResponse:
    settings = get_settings()
    row = get_task_row(settings.db_path, task_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")

    row_dict = dict(row)
    artifacts_dir = _resolve_artifacts_dir(task_id, row_dict.get("artifacts_dir"))
    artifacts = [item.name for item in _list_artifact_items(artifacts_dir)]

    payload = {
        **row_dict,
        "artifacts": artifacts,
        "apply_instructions": _build_apply_instructions(task_id),
    }
    return IdeTaskResponse(**payload)


@router.get(
    "/tasks/{task_id}/diff",
    dependencies=[Depends(require_auth)],
)
def ide_get_task_diff(task_id: str) -> PlainTextResponse:
    settings = get_settings()
    row = get_task_row(settings.db_path, task_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")

    artifacts_dir = _resolve_artifacts_dir(task_id, row["artifacts_dir"])
    if artifacts_dir is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="artifacts not found")

    diff_path = ensure_path_under(artifacts_dir, artifacts_dir / "diff.patch")
    if not diff_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="diff.patch not found")

    content = diff_path.read_text(encoding="utf-8", errors="replace")
    return PlainTextResponse(content=content, media_type="text/x-diff")


@router.get(
    "/tasks/{task_id}/artifacts",
    response_model=IdeArtifactsListResponse,
    dependencies=[Depends(require_auth)],
)
def ide_list_artifacts(task_id: str) -> IdeArtifactsListResponse:
    settings = get_settings()
    row = get_task_row(settings.db_path, task_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")

    artifacts_dir = _resolve_artifacts_dir(task_id, row["artifacts_dir"])
    items = _list_artifact_items(artifacts_dir)

    return IdeArtifactsListResponse(
        task_id=task_id,
        artifacts_dir=str(artifacts_dir) if artifacts_dir else None,
        artifacts=items,
    )


@router.get(
    "/tasks/{task_id}/artifacts/{artifact_name:path}",
    dependencies=[Depends(require_auth)],
)
def ide_get_artifact(
    task_id: str,
    artifact_name: str,
    max_bytes: int = Query(default=10485760, ge=1, le=104857600),
) -> Response:
    settings = get_settings()
    row = get_task_row(settings.db_path, task_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")

    artifacts_dir = _resolve_artifacts_dir(task_id, row["artifacts_dir"])
    if artifacts_dir is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="artifacts not found")

    artifact_rel = artifact_name.strip().lstrip("/")
    if not artifact_rel:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="artifact name is required")

    target = ensure_path_under(artifacts_dir, artifacts_dir / artifact_rel)
    if not target.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="artifact not found")

    size = target.stat().st_size
    if size > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"artifact too large ({size} bytes > max_bytes={max_bytes})",
        )

    data = target.read_bytes()
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{target.name}"',
            "X-Clawbrain-Artifact-Path": artifact_rel,
        },
    )
