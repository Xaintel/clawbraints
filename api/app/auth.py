#!/usr/bin/env python3
"""Token authentication dependency for ClawBrain API."""

from __future__ import annotations

import hmac
import os
import stat
from pathlib import Path

from fastapi import Header, HTTPException, Query, status

from api.app.storage import get_settings


def _read_token_file(path: Path) -> str | None:
    if not path.is_file():
        return None

    mode = stat.S_IMODE(path.stat().st_mode)
    if mode != 0o600:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"token file must have permission 600: {path}",
        )

    token = path.read_text(encoding="utf-8").strip()
    return token or None


def get_expected_token() -> str | None:
    env_token = os.environ.get("CLAWBRAIN_API_TOKEN", "").strip()
    if env_token:
        return env_token

    settings = get_settings()
    return _read_token_file(settings.api_token_file)


def require_auth(x_clawbrain_token: str | None = Header(default=None, alias="X-Clawbrain-Token")) -> None:
    expected = get_expected_token()
    provided = (x_clawbrain_token or "").strip()

    if not expected or not provided:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")

    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")


def require_auth_or_query_token(
    x_clawbrain_token: str | None = Header(default=None, alias="X-Clawbrain-Token"),
    token: str | None = Query(default=None, alias="token"),
) -> None:
    expected = get_expected_token()
    provided = (x_clawbrain_token or token or "").strip()

    if not expected or not provided:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")

    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
