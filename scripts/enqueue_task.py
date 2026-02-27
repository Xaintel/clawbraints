#!/usr/bin/env python3
"""CLI to enqueue runner tasks in Redis."""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Ensure repo root is importable when running as: python scripts/enqueue_task.py
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from runner.db import create_task
from runner.logging import resolve_log_path
from runner.queue import QueueError, RedisQueue

DEFAULT_DB_PATH = Path("/data/clawbrain/db/clawbrain.sqlite3")
DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"
DEFAULT_QUEUE_NAME = "clawbrain:tasks"
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
ALLOWED_JOB_TYPES = ("command", "codex")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Enqueue a ClawBrain task.")
    parser.add_argument("--type", default="command", choices=ALLOWED_JOB_TYPES)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--agent", required=True, choices=ALLOWED_AGENTS)
    parser.add_argument("--command")
    parser.add_argument("--request-text", required=True)
    parser.add_argument("--session-id")
    parser.add_argument("--stack")
    parser.add_argument(
        "--db-path",
        default=os.environ.get("CLAWBRAIN_DB_PATH", str(DEFAULT_DB_PATH)),
    )
    parser.add_argument(
        "--redis-url",
        default=os.environ.get("CLAWBRAIN_REDIS_URL", DEFAULT_REDIS_URL),
    )
    parser.add_argument(
        "--queue-name",
        default=os.environ.get("CLAWBRAIN_QUEUE_NAME", DEFAULT_QUEUE_NAME),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    task_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    db_path = Path(args.db_path).expanduser()
    job_type = args.type.strip()
    repo = args.repo.strip()
    agent = args.agent.strip()
    command = (args.command or "").strip()

    if job_type == "command" and not command:
        print("[FAIL] --command is required when --type=command")
        return 1

    if job_type == "codex" and not command:
        command = (
            f"codex exec --skip-git-repo-check --sandbox workspace-write "
            f"-C /srv/projects/{repo} -"
        )

    logs_dir = Path(os.environ.get("CLAWBRAIN_LOGS_DIR", "/data/clawbrain/logs")).resolve()
    log_path = resolve_log_path(task_id, logs_dir=logs_dir)

    payload = {
        "task_id": task_id,
        "session_id": args.session_id,
        "type": job_type,
        "repo": repo,
        "agent": agent,
        "command": command,
        "request_text": args.request_text,
        "stack": args.stack,
        "db_path": str(db_path),
        "created_at": created_at,
    }

    create_task(
        db_path,
        task_id=task_id,
        session_id=args.session_id,
        repo=repo,
        agent=agent,
        status="queued",
        request_text=args.request_text,
        log_path=str(log_path),
        created_at=created_at,
    )

    queue = RedisQueue(redis_url=args.redis_url, queue_name=args.queue_name)
    try:
        queue.ping()
        queue.enqueue(payload)
    except QueueError as exc:
        print(f"[FAIL] queue error: {exc}")
        return 1

    print(
        json.dumps(
            {
                "task_id": task_id,
                "type": job_type,
                "queue_name": args.queue_name,
                "db_path": str(db_path),
                "log_path": str(log_path),
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
