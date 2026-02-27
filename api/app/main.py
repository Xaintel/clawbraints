#!/usr/bin/env python3
"""FastAPI service for ClawBrain task API."""

from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from api.app.auth import require_auth
from api.app.ide import router as ide_router
from api.app.models import (
    RepoMemoryPutRequest,
    RepoMemoryResponse,
    TaskCreateRequest,
    TaskCreateResponse,
    TaskLogsResponse,
    TaskResponse,
)
from api.app.storage import (
    ensure_path_under,
    get_memory_path,
    get_settings,
    get_task_row,
    read_policy_or_error,
)
from runner.db import create_task, upsert_repo_memory_index
from runner.logging import resolve_log_path
from runner.queue import QueueError, RedisQueue
from shared.policy import (
    PolicyError,
    resolve_repo_path,
    validate_agent,
    validate_command_whitelist,
    validate_paths_write,
    validate_repo_allowed,
)

app = FastAPI(title="ClawBrain API", version="0.1.0")
app.include_router(ide_router, prefix="/ide")
app.include_router(ide_router, prefix="/api/ide", include_in_schema=False)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _policy_error_to_http(exc: Exception) -> HTTPException:
    if isinstance(exc, PolicyError):
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))


@app.get("/health")
def health() -> dict[str, str]:
    # Health is intentionally open to allow local liveness checks.
    return {"status": "ok"}


@app.post("/tasks", response_model=TaskCreateResponse, dependencies=[Depends(require_auth)])
def create_task_endpoint(payload: TaskCreateRequest) -> TaskCreateResponse:
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
        "repo": repo,
        "agent": agent,
        "command": command,
        "request_text": request_text,
        "prompt": payload.prompt,
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

    return TaskCreateResponse(task_id=task_id, status="queued")


@app.get("/tasks/{task_id}", response_model=TaskResponse, dependencies=[Depends(require_auth)])
def get_task_endpoint(task_id: str) -> TaskResponse:
    settings = get_settings()
    row = get_task_row(settings.db_path, task_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")
    return TaskResponse(**dict(row))


@app.get("/tasks/{task_id}/logs", response_model=TaskLogsResponse, dependencies=[Depends(require_auth)])
def get_task_logs_endpoint(
    task_id: str,
    max_bytes: int = Query(default=8192, ge=1, le=262144),
) -> JSONResponse:
    settings = get_settings()
    row = get_task_row(settings.db_path, task_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")

    log_path_raw = row["log_path"]
    if not isinstance(log_path_raw, str) or not log_path_raw.strip():
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="task has no log path")

    log_path = ensure_path_under(settings.logs_dir, Path(log_path_raw))
    if not log_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="log not found")

    raw = log_path.read_bytes()
    truncated = len(raw) > max_bytes
    tail = raw[-max_bytes:] if truncated else raw
    content = tail.decode("utf-8", errors="replace")
    lines = content.splitlines()
    content_b64 = base64.b64encode(content.encode("utf-8", "replace")).decode("ascii")

    payload = {
        "task_id": task_id,
        "log_path": str(log_path),
        "lines": lines,
        "content_b64": content_b64,
        "truncated": truncated,
    }
    return JSONResponse(content=jsonable_encoder(payload))


@app.get(
    "/repos/{repo}/memory",
    response_model=RepoMemoryResponse,
    dependencies=[Depends(require_auth)],
)
def get_repo_memory(repo: str) -> RepoMemoryResponse:
    settings = get_settings()
    try:
        policy = read_policy_or_error(settings)
        validate_repo_allowed(policy, repo)
        memory_path = get_memory_path(settings, repo)
    except Exception as exc:
        raise _policy_error_to_http(exc) from exc

    if not memory_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="memory file not found")

    content = memory_path.read_text(encoding="utf-8")
    return RepoMemoryResponse(repo=repo, memory_path=str(memory_path), content=content)


@app.put(
    "/repos/{repo}/memory",
    response_model=RepoMemoryResponse,
    dependencies=[Depends(require_auth)],
)
def put_repo_memory(repo: str, body: RepoMemoryPutRequest) -> RepoMemoryResponse:
    settings = get_settings()
    try:
        policy = read_policy_or_error(settings)
        validate_repo_allowed(policy, repo)
        memory_path = get_memory_path(settings, repo)
        validate_paths_write(policy, memory_path)
    except Exception as exc:
        raise _policy_error_to_http(exc) from exc

    memory_path.write_text(body.content, encoding="utf-8")
    content_hash = hashlib.sha256(body.content.encode("utf-8")).hexdigest()
    upsert_repo_memory_index(
        settings.db_path,
        repo=repo,
        memory_path=str(memory_path),
        updated_at=_now_iso(),
        content_hash=content_hash,
    )

    return RepoMemoryResponse(repo=repo, memory_path=str(memory_path), content=body.content)
