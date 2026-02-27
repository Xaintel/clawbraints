#!/usr/bin/env python3
"""Redis queue helpers for runner jobs."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import socket
from typing import Any

import redis


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class QueueError(Exception):
    """Raised when queue operations fail."""


class RedisQueue:
    def __init__(self, *, redis_url: str, queue_name: str) -> None:
        self.redis_url = redis_url
        self.queue_name = queue_name
        self.client = redis.Redis.from_url(redis_url, decode_responses=True)

    def ping(self) -> None:
        try:
            self.client.ping()
        except redis.RedisError as exc:
            raise QueueError(f"redis ping failed: {exc}") from exc

    def enqueue(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=True)
        try:
            self.client.rpush(self.queue_name, body)
        except redis.RedisError as exc:
            raise QueueError(f"redis enqueue failed: {exc}") from exc

    def dequeue(self, *, timeout: int) -> dict[str, Any] | None:
        try:
            item = self.client.blpop(self.queue_name, timeout=timeout)
        except redis.RedisError as exc:
            raise QueueError(f"redis dequeue failed: {exc}") from exc

        if item is None:
            return None

        _, raw_payload = item
        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError as exc:
            raise QueueError(f"invalid job payload JSON: {exc}") from exc

        if not isinstance(payload, dict):
            raise QueueError("queue payload must be a JSON object")

        return payload

    def length(self) -> int:
        try:
            return int(self.client.llen(self.queue_name))
        except redis.RedisError as exc:
            raise QueueError(f"redis length failed: {exc}") from exc

    def publish_heartbeat(
        self,
        *,
        agent: str,
        linux_user: str,
        ttl_seconds: int = 45,
        extra: dict[str, Any] | None = None,
    ) -> str:
        host = socket.gethostname()
        pid = os.getpid()
        key = f"clawbrain:agent_heartbeat:{agent}:{linux_user}:{host}:{pid}"
        payload = {
            "agent": agent,
            "linux_user": linux_user,
            "host": host,
            "pid": pid,
            "queue": self.queue_name,
            "ts": utc_now_iso(),
        }
        if extra:
            payload.update(extra)

        try:
            self.client.set(key, json.dumps(payload, ensure_ascii=True), ex=max(15, int(ttl_seconds)))
        except redis.RedisError as exc:
            raise QueueError(f"redis publish heartbeat failed: {exc}") from exc
        return key

    def list_heartbeats(self, *, key_prefix: str = "clawbrain:agent_heartbeat:") -> list[dict[str, Any]]:
        heartbeats: list[dict[str, Any]] = []
        pattern = f"{key_prefix}*"
        try:
            for key in self.client.scan_iter(match=pattern):
                raw = self.client.get(key)
                if not raw:
                    continue
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    parsed["_key"] = key
                    heartbeats.append(parsed)
        except redis.RedisError as exc:
            raise QueueError(f"redis list heartbeats failed: {exc}") from exc
        return heartbeats
