#!/usr/bin/env python3
"""Safe task log writer."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

DEFAULT_LOGS_DIR = Path("/data/clawbrain/logs")


def _ensure_inside(base_dir: Path, target: Path) -> None:
    resolved_base = base_dir.resolve()
    resolved_target = target.resolve()
    if not resolved_target.is_relative_to(resolved_base):
        raise ValueError(f"path escapes log root: {resolved_target}")


def resolve_log_path(task_id: str, logs_dir: str | Path | None = None) -> Path:
    task = (task_id or "").strip()
    if not task:
        raise ValueError("task_id must be non-empty")
    if "/" in task or "\\" in task:
        raise ValueError("task_id must not contain path separators")

    root = Path(logs_dir or DEFAULT_LOGS_DIR).resolve()
    root.mkdir(parents=True, exist_ok=True)
    log_path = (root / f"{task}.log").resolve()
    _ensure_inside(root, log_path)
    return log_path


def append_log(log_path: str | Path, message: str, *, logs_dir: str | Path | None = None) -> None:
    path = Path(log_path).resolve()
    root = Path(logs_dir or DEFAULT_LOGS_DIR).resolve()
    root.mkdir(parents=True, exist_ok=True)
    _ensure_inside(root, path)

    timestamp = datetime.now(timezone.utc).isoformat()
    line = f"[{timestamp}] {message.rstrip()}\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)

