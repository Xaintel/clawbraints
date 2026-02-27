#!/usr/bin/env python3
"""Repository memory updater."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path

from runner.db import upsert_repo_memory_index

DEFAULT_MEMORY_DIR = Path("/data/clawbrain/memory")
REPO_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _validate_repo_name(repo: str) -> str:
    name = (repo or "").strip()
    if not name:
        raise ValueError("repo must be non-empty")
    if not REPO_NAME_RE.fullmatch(name):
        raise ValueError(f"invalid repo name: {repo}")
    return name


def _resolve_memory_path(repo: str, memory_dir: str | Path | None = None) -> Path:
    root = Path(memory_dir or DEFAULT_MEMORY_DIR).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = (root / f"{repo}.md").resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"memory path escapes root: {path}")
    return path


def update_memory(
    repo: str,
    summary_text: str,
    *,
    db_path: str | Path,
    memory_dir: str | Path | None = None,
) -> tuple[Path, str]:
    repo_name = _validate_repo_name(repo)
    memory_path = _resolve_memory_path(repo_name, memory_dir=memory_dir)

    if not memory_path.exists():
        memory_path.touch()
    # Memory is shared across agent users; keep it writable for codex/builder runners.
    try:
        memory_path.chmod(0o666)
    except PermissionError:
        # If ownership changed unexpectedly we still try append; failure is handled by caller.
        pass

    ts = datetime.now(timezone.utc).isoformat()
    line = f"- {ts} {summary_text.strip()}\n"
    with memory_path.open("a", encoding="utf-8") as handle:
        handle.write(line)

    content = memory_path.read_bytes()
    content_hash = hashlib.sha256(content).hexdigest()
    upsert_repo_memory_index(
        db_path,
        repo=repo_name,
        memory_path=str(memory_path),
        updated_at=ts,
        content_hash=content_hash,
    )
    return memory_path, content_hash
