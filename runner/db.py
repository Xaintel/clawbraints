#!/usr/bin/env python3
"""SQLite helper functions for runner task lifecycle and auditing."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_DB_PATH = Path("/data/clawbrain/db/clawbrain.sqlite3")
TASK_STATUS_VALUES = {"queued", "running", "succeeded", "failed", "canceled", "blocked"}
ACTOR_TYPE_VALUES = {"agent", "user", "system"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect_db(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(Path(db_path)))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def _validate_status(status: str) -> None:
    if status not in TASK_STATUS_VALUES:
        raise ValueError(f"invalid status: {status}")


def create_task(
    db_path: str | Path,
    *,
    task_id: str,
    session_id: str | None,
    repo: str,
    agent: str,
    status: str,
    request_text: str,
    log_path: str,
    artifacts_dir: str | None = None,
    created_at: str | None = None,
) -> None:
    _validate_status(status)
    created = created_at or utc_now_iso()

    with connect_db(db_path) as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO tasks (
              id, session_id, repo, agent, status, request_text, created_at, log_path, artifacts_dir
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                session_id,
                repo,
                agent,
                status,
                request_text,
                created,
                log_path,
                artifacts_dir,
            ),
        )


def update_task_status(
    db_path: str | Path,
    *,
    task_id: str,
    status: str,
    started_at: str | None = None,
    finished_at: str | None = None,
    exit_code: int | None = None,
    summary_text: str | None = None,
    log_path: str | None = None,
    artifacts_dir: str | None = None,
) -> None:
    _validate_status(status)

    fields: list[str] = ["status = ?"]
    values: list[Any] = [status]

    if started_at is not None:
        fields.append("started_at = ?")
        values.append(started_at)
    if finished_at is not None:
        fields.append("finished_at = ?")
        values.append(finished_at)
    if exit_code is not None:
        fields.append("exit_code = ?")
        values.append(exit_code)
    if summary_text is not None:
        fields.append("summary_text = ?")
        values.append(summary_text)
    if log_path is not None:
        fields.append("log_path = ?")
        values.append(log_path)
    if artifacts_dir is not None:
        fields.append("artifacts_dir = ?")
        values.append(artifacts_dir)

    values.append(task_id)
    sql = f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?"

    with connect_db(db_path) as conn:
        conn.execute(sql, values)


def insert_audit_event(
    db_path: str | Path,
    *,
    task_id: str,
    actor_type: str,
    actor: str,
    action: str,
    detail: dict[str, Any] | str,
    ts: str | None = None,
) -> None:
    if actor_type not in ACTOR_TYPE_VALUES:
        raise ValueError(f"invalid actor_type: {actor_type}")

    detail_json = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=True)
    event_ts = ts or utc_now_iso()

    with connect_db(db_path) as conn:
        conn.execute(
            """
            INSERT INTO audit_events (task_id, ts, actor_type, actor, action, detail_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (task_id, event_ts, actor_type, actor, action, detail_json),
        )


def upsert_repo_memory_index(
    db_path: str | Path,
    *,
    repo: str,
    memory_path: str,
    updated_at: str | None = None,
    content_hash: str | None = None,
) -> None:
    ts = updated_at or utc_now_iso()
    with connect_db(db_path) as conn:
        conn.execute(
            """
            INSERT INTO repo_memory_index (repo, memory_path, updated_at, content_hash)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(repo) DO UPDATE SET
              memory_path = excluded.memory_path,
              updated_at = excluded.updated_at,
              content_hash = excluded.content_hash
            """,
            (repo, memory_path, ts, content_hash),
        )
