#!/usr/bin/env python3
"""HTTP client and local patch helpers for ClawBrain IDE integration."""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ide_client.config import IDEClientConfig


class IDEClientError(RuntimeError):
    """Base error for IDE client interactions."""


@dataclass(frozen=True)
class HTTPErrorDetail(IDEClientError):
    status_code: int
    message: str
    response_body: str

    def __str__(self) -> str:
        if self.response_body:
            return f"HTTP {self.status_code}: {self.message} ({self.response_body})"
        return f"HTTP {self.status_code}: {self.message}"


class ClawBrainIDEClient:
    def __init__(self, config: IDEClientConfig) -> None:
        self.server_url = config.server_url.rstrip("/")
        self.token = config.token
        self.timeout_sec = config.timeout_sec

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        accept: str = "application/json",
    ) -> tuple[bytes, str]:
        base = f"{self.server_url}{path}"
        if query:
            query_str = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
            if query_str:
                base = f"{base}?{query_str}"

        data = None
        headers = {
            "X-Clawbrain-Token": self.token,
            "Accept": accept,
            "User-Agent": "clawbrain-ide/0.1",
        }
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=True).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(base, method=method, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                body = resp.read()
                content_type = resp.headers.get("Content-Type", "")
                return body, content_type
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise HTTPErrorDetail(exc.code, exc.reason, body) from exc
        except urllib.error.URLError as exc:
            raise IDEClientError(f"request failed: {exc}") from exc

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raw, _ = self._request(method, path, json_body=json_body, query=query, accept="application/json")
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise IDEClientError(f"invalid JSON response for {method} {path}: {exc}") from exc
        if not isinstance(parsed, dict):
            raise IDEClientError(f"expected JSON object response for {method} {path}")
        return parsed

    def list_agents(self) -> dict[str, Any]:
        return self._request_json("GET", "/api/ide/agents")

    def create_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request_json("POST", "/api/ide/tasks", json_body=payload)

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._request_json("GET", f"/api/ide/tasks/{task_id}")

    def get_logs(self, task_id: str, *, max_bytes: int = 8192) -> dict[str, Any]:
        return self._request_json("GET", f"/api/tasks/{task_id}/logs", query={"max_bytes": max_bytes})

    def get_diff(self, task_id: str) -> str:
        raw, _ = self._request("GET", f"/api/ide/tasks/{task_id}/diff", accept="text/x-diff")
        return raw.decode("utf-8", errors="replace")

    def list_artifacts(self, task_id: str) -> dict[str, Any]:
        return self._request_json("GET", f"/api/ide/tasks/{task_id}/artifacts")

    def get_artifact(self, task_id: str, artifact_name: str) -> bytes:
        safe_name = artifact_name.strip().lstrip("/")
        if not safe_name:
            raise IDEClientError("artifact_name cannot be empty")
        path = f"/api/ide/tasks/{task_id}/artifacts/{safe_name}"
        raw, _ = self._request("GET", path, accept="application/octet-stream")
        return raw

    def wait_task(
        self,
        task_id: str,
        *,
        timeout_sec: int,
        poll_interval_sec: float,
        success_statuses: set[str],
        error_statuses: set[str],
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_sec
        last_payload: dict[str, Any] | None = None

        while time.monotonic() < deadline:
            payload = self.get_task(task_id)
            last_payload = payload
            status = str(payload.get("status", ""))
            if status in success_statuses:
                return payload
            if status in error_statuses:
                raise IDEClientError(f"task finished in status={status}")
            time.sleep(poll_interval_sec)

        if last_payload is not None:
            raise IDEClientError(
                f"timeout waiting task {task_id}. last status={last_payload.get('status')}"
            )
        raise IDEClientError(f"timeout waiting task {task_id}")


def apply_patch_local(
    *,
    patch_path: Path,
    repo_path: Path,
    yes: bool,
    index: bool,
) -> dict[str, Any]:
    patch = patch_path.expanduser().resolve()
    repo = repo_path.expanduser().resolve()

    if not patch.is_file():
        raise IDEClientError(f"patch file not found: {patch}")
    if not repo.exists() or not repo.is_dir():
        raise IDEClientError(f"repo path not found: {repo}")

    patch_text = patch.read_text(encoding="utf-8", errors="replace")
    if not patch_text.strip():
        return {
            "applied": False,
            "reason": "empty patch",
            "repo_path": str(repo),
            "patch_path": str(patch),
        }

    git_check = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
        check=False,
    )
    if git_check.returncode != 0:
        raise IDEClientError(
            f"target path is not a git worktree: {repo} ({git_check.stderr.strip()})"
        )

    if not yes:
        preview = "\n".join(patch_text.splitlines()[:20])
        print("Patch preview (first 20 lines):")
        print(preview)
        answer = input("Apply patch locally with git apply? [y/N]: ").strip().lower()
        if answer not in {"y", "yes"}:
            return {
                "applied": False,
                "reason": "user_declined",
                "repo_path": str(repo),
                "patch_path": str(patch),
            }

    cmd = ["git", "-C", str(repo), "apply"]
    if index:
        cmd.append("--index")
    cmd.append(str(patch))

    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise IDEClientError(
            f"git apply failed (exit={result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
        )

    return {
        "applied": True,
        "repo_path": str(repo),
        "patch_path": str(patch),
        "index": index,
    }
