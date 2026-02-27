#!/usr/bin/env python3
"""Configuration and storage helpers for ClawBrain API."""

from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from shared.policy import PolicyConfig, PolicyError, load_policy

REPO_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


@dataclass(frozen=True)
class Settings:
    config_dir: Path
    db_path: Path
    logs_dir: Path
    memory_dir: Path
    artifacts_dir: Path
    redis_url: str
    queue_name: str
    api_token_file: Path

    @property
    def policy_path(self) -> Path:
        return self.config_dir / "policy.yaml"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    config_dir = Path(os.environ.get("CLAWBRAIN_CONFIG_DIR", "/data/clawbrain/config")).resolve()
    db_path = Path(os.environ.get("CLAWBRAIN_DB_PATH", "/data/clawbrain/db/clawbrain.sqlite3")).resolve()
    logs_dir = Path(os.environ.get("CLAWBRAIN_LOGS_DIR", "/data/clawbrain/logs")).resolve()
    memory_dir = Path(os.environ.get("CLAWBRAIN_MEMORY_DIR", "/data/clawbrain/memory")).resolve()
    artifacts_dir = Path(
        os.environ.get("CLAWBRAIN_ARTIFACTS_DIR", "/data/clawbrain/artifacts")
    ).resolve()
    redis_url = os.environ.get("CLAWBRAIN_REDIS_URL", "redis://127.0.0.1:6379/0")
    queue_name = os.environ.get("CLAWBRAIN_QUEUE_NAME", "clawbrain:tasks")
    token_file = Path(
        os.environ.get("CLAWBRAIN_API_TOKEN_FILE", "/data/clawbrain/secrets/api_token")
    ).resolve()

    return Settings(
        config_dir=config_dir,
        db_path=db_path,
        logs_dir=logs_dir,
        memory_dir=memory_dir,
        artifacts_dir=artifacts_dir,
        redis_url=redis_url,
        queue_name=queue_name,
        api_token_file=token_file,
    )


def load_active_policy(settings: Settings | None = None) -> PolicyConfig:
    cfg = settings or get_settings()
    return load_policy(cfg.policy_path)


def ensure_path_under(base_dir: Path, target_path: Path) -> Path:
    base = base_dir.resolve()
    target = target_path.resolve()
    if not target.is_relative_to(base):
        raise ValueError(f"path escapes base directory: {target}")
    return target


def validate_repo_name(repo: str) -> str:
    repo_name = (repo or "").strip()
    if not repo_name:
        raise ValueError("repo must be non-empty")
    if not REPO_NAME_RE.fullmatch(repo_name):
        raise ValueError(f"invalid repo name: {repo}")
    return repo_name


def get_memory_path(settings: Settings, repo: str) -> Path:
    repo_name = validate_repo_name(repo)
    settings.memory_dir.mkdir(parents=True, exist_ok=True)
    return ensure_path_under(settings.memory_dir, settings.memory_dir / f"{repo_name}.md")


def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def get_task_row(db_path: Path, task_id: str) -> sqlite3.Row | None:
    with connect_db(db_path) as conn:
        return conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()


def read_policy_or_error(settings: Settings | None = None) -> PolicyConfig:
    cfg = settings or get_settings()
    try:
        return load_active_policy(cfg)
    except PolicyError as exc:
        raise RuntimeError(f"active policy is invalid: {exc}") from exc

