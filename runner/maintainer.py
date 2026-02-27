#!/usr/bin/env python3
"""Agent maintainer: monitors worker heartbeats and queue depth."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from typing import Any

from runner.queue import QueueError, RedisQueue
from shared.policy import load_policy

DEFAULT_CONFIG_DIR = Path("/data/clawbrain/config")
DEFAULT_LOGS_DIR = Path("/data/clawbrain/logs")
DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"
DEFAULT_QUEUE_NAME = "clawbrain:tasks"
DEFAULT_STATUS_REDIS_KEY = "clawbrain:agent_status:latest"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def parse_iso_ts(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ClawBrain agent maintainer")
    parser.add_argument(
        "--config-dir",
        default=os.environ.get("CLAWBRAIN_CONFIG_DIR", str(DEFAULT_CONFIG_DIR)),
    )
    parser.add_argument(
        "--logs-dir",
        default=os.environ.get("CLAWBRAIN_LOGS_DIR", str(DEFAULT_LOGS_DIR)),
    )
    parser.add_argument(
        "--redis-url",
        default=os.environ.get("CLAWBRAIN_REDIS_URL", DEFAULT_REDIS_URL),
    )
    parser.add_argument(
        "--queue-name",
        default=os.environ.get("CLAWBRAIN_QUEUE_NAME", DEFAULT_QUEUE_NAME),
    )
    parser.add_argument(
        "--heartbeat-stale-seconds",
        type=int,
        default=int(os.environ.get("CLAWBRAIN_HEARTBEAT_STALE_SEC", "90")),
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=int(os.environ.get("CLAWBRAIN_MAINTAINER_INTERVAL_SEC", "15")),
    )
    parser.add_argument(
        "--status-file",
        default=os.environ.get(
            "CLAWBRAIN_AGENT_STATUS_FILE",
            str(DEFAULT_LOGS_DIR / "agent_maintainer_status.json"),
        ),
    )
    parser.add_argument(
        "--status-redis-key",
        default=os.environ.get("CLAWBRAIN_AGENT_STATUS_REDIS_KEY", DEFAULT_STATUS_REDIS_KEY),
    )
    parser.add_argument(
        "--required-agents",
        default=os.environ.get("CLAWBRAIN_MAINTAINER_REQUIRED_AGENTS", "").strip(),
        help="Comma-separated agent names to monitor. Empty = all policy agents.",
    )
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--fail-on-missing", action="store_true")
    return parser.parse_args()


def build_status_snapshot(
    *,
    queue: RedisQueue,
    expected_agents: set[str],
    stale_seconds: int,
) -> dict[str, Any]:
    now = utc_now()
    stale_after = max(10, int(stale_seconds))
    queue_depth = queue.length()
    heartbeats = queue.list_heartbeats()

    by_agent: dict[str, list[dict[str, Any]]] = {}
    for entry in heartbeats:
        agent_name = str(entry.get("agent") or "").strip()
        if not agent_name:
            continue
        by_agent.setdefault(agent_name, []).append(entry)

    agents_summary: list[dict[str, Any]] = []
    missing_agents: list[str] = []

    for agent in sorted(expected_agents):
        instances = by_agent.get(agent, [])
        running_instances: list[dict[str, Any]] = []
        newest_ts: datetime | None = None

        for item in instances:
            ts = parse_iso_ts(item.get("ts"))
            age_s = None
            stale = True
            if ts is not None:
                age_s = int((now - ts).total_seconds())
                stale = age_s > stale_after
                if newest_ts is None or ts > newest_ts:
                    newest_ts = ts

            running_instances.append(
                {
                    "linux_user": item.get("linux_user"),
                    "host": item.get("host"),
                    "pid": item.get("pid"),
                    "state": item.get("state"),
                    "queue": item.get("queue"),
                    "ts": item.get("ts"),
                    "age_s": age_s,
                    "stale": stale,
                }
            )

        active_instances = [item for item in running_instances if not item["stale"]]
        alive = len(active_instances) > 0
        if not alive:
            missing_agents.append(agent)

        agents_summary.append(
            {
                "name": agent,
                "alive": alive,
                "instances_total": len(running_instances),
                "instances_active": len(active_instances),
                "last_seen_ts": newest_ts.isoformat() if newest_ts is not None else None,
                "instances": running_instances,
            }
        )

    return {
        "ts": utc_now_iso(),
        "queue_name": queue.queue_name,
        "queue_depth": queue_depth,
        "heartbeat_stale_seconds": stale_after,
        "expected_agents": sorted(expected_agents),
        "missing_agents": missing_agents,
        "agents": agents_summary,
    }


def write_status(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def run_once(args: argparse.Namespace) -> int:
    config_dir = Path(args.config_dir).resolve()
    status_file = Path(args.status_file).resolve()
    policy_path = config_dir / "policy.yaml"
    policy = load_policy(policy_path)
    configured_required = [
        item.strip() for item in str(args.required_agents).split(",") if item.strip()
    ]
    expected_agents = set(configured_required) if configured_required else set(policy.agents.keys())

    queue = RedisQueue(redis_url=args.redis_url, queue_name=args.queue_name)
    queue.ping()
    snapshot = build_status_snapshot(
        queue=queue,
        expected_agents=expected_agents,
        stale_seconds=args.heartbeat_stale_seconds,
    )
    queue.publish_heartbeat(
        agent="AgentMaintainer",
        linux_user=os.environ.get("CLAWBRAIN_MAINTAINER_LINUX_USER", "codex"),
        ttl_seconds=max(20, int(args.interval_seconds) * 2),
        extra={"state": "idle", "queue_depth": snapshot.get("queue_depth", 0)},
    )
    queue.client.set(str(args.status_redis_key), json.dumps(snapshot, ensure_ascii=True))
    try:
        write_status(status_file, snapshot)
    except OSError as exc:
        print(f"[maintainer][WARN] status file write skipped: {exc}")

    missing = snapshot.get("missing_agents", [])
    print(
        f"[maintainer] ts={snapshot['ts']} queue_depth={snapshot['queue_depth']} "
        f"missing_agents={len(missing)} status_file={status_file} "
        f"status_redis_key={args.status_redis_key}"
    )
    if missing:
        print(f"[maintainer] missing={','.join(missing)}")
        if args.fail_on_missing:
            return 1
    return 0


def main() -> int:
    args = parse_args()
    interval = max(5, int(args.interval_seconds))

    while True:
        try:
            code = run_once(args)
        except (QueueError, OSError, ValueError) as exc:
            print(f"[maintainer][FAIL] {exc}")
            code = 1
        except Exception as exc:  # noqa: BLE001
            print(f"[maintainer][FAIL] unexpected error: {exc}")
            code = 1

        if args.once:
            return code

        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
