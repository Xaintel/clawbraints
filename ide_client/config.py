#!/usr/bin/env python3
"""Local configuration helpers for clawbrain-ide tools."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ENV_CONFIG_PATH = "CLAWBRAIN_IDE_CONFIG"
ENV_SERVER_URL = "CLAWBRAIN_IDE_SERVER_URL"
ENV_TOKEN = "CLAWBRAIN_IDE_TOKEN"
ENV_TIMEOUT_SEC = "CLAWBRAIN_IDE_TIMEOUT_SEC"

DEFAULT_SERVER_URL = "http://127.0.0.1:8088"
DEFAULT_TIMEOUT_SEC = 30
DEFAULT_CONFIG_PATH = Path.home() / ".config" / "clawbrain-ide" / "config.json"


class ConfigError(RuntimeError):
    """Raised when CLI configuration is invalid."""


@dataclass(frozen=True)
class IDEClientConfig:
    server_url: str
    token: str
    timeout_sec: int
    config_path: Path


def _resolve_config_path() -> Path:
    raw = os.environ.get(ENV_CONFIG_PATH, "").strip()
    return Path(raw).expanduser().resolve() if raw else DEFAULT_CONFIG_PATH.resolve()


def _normalize_server_url(server_url: str) -> str:
    value = (server_url or "").strip()
    if not value:
        raise ConfigError("server_url cannot be empty")
    if not value.startswith("http://") and not value.startswith("https://"):
        raise ConfigError("server_url must start with http:// or https://")
    return value.rstrip("/")


def _read_config_file(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        content = path.read_text(encoding="utf-8")
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"invalid JSON config at {path}: {exc}") from exc
    except OSError as exc:
        raise ConfigError(f"failed to read config file {path}: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ConfigError(f"config file must contain a JSON object: {path}")
    return parsed


def _parse_timeout(raw: Any) -> int:
    if raw is None:
        return DEFAULT_TIMEOUT_SEC
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"invalid timeout value: {raw}") from exc
    if value <= 0:
        raise ConfigError("timeout must be > 0")
    return value


def load_config(*, require_token: bool = True) -> IDEClientConfig:
    path = _resolve_config_path()
    file_data = _read_config_file(path)

    raw_server_url = os.environ.get(ENV_SERVER_URL, "").strip() or str(
        file_data.get("server_url", DEFAULT_SERVER_URL)
    )
    raw_token = os.environ.get(ENV_TOKEN, "").strip() or str(file_data.get("token", "")).strip()
    raw_timeout = os.environ.get(ENV_TIMEOUT_SEC, "").strip() or file_data.get(
        "timeout_sec", DEFAULT_TIMEOUT_SEC
    )

    server_url = _normalize_server_url(raw_server_url)
    timeout_sec = _parse_timeout(raw_timeout)

    if require_token and not raw_token:
        raise ConfigError(
            "missing token. set CLAWBRAIN_IDE_TOKEN or run 'clawbrain-ide config-set --token ...'"
        )

    return IDEClientConfig(
        server_url=server_url,
        token=raw_token,
        timeout_sec=timeout_sec,
        config_path=path,
    )


def save_config(
    *,
    server_url: str | None = None,
    token: str | None = None,
    timeout_sec: int | None = None,
) -> Path:
    path = _resolve_config_path()
    data = _read_config_file(path)

    if server_url is not None:
        data["server_url"] = _normalize_server_url(server_url)
    if token is not None:
        token_clean = token.strip()
        if not token_clean:
            raise ConfigError("token cannot be empty")
        data["token"] = token_clean
    if timeout_sec is not None:
        data["timeout_sec"] = _parse_timeout(timeout_sec)

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True)
    path.write_text(payload + "\n", encoding="utf-8")
    path.chmod(0o600)
    return path
