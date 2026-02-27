#!/usr/bin/env python3
"""Auto-improvement agent: analyzes runtime health and emits recommendations."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from typing import Any

from runner.queue import QueueError, RedisQueue
from shared.policy import PolicyError, load_policy

DEFAULT_CONFIG_DIR = Path("/data/clawbrain/config")
DEFAULT_LOGS_DIR = Path("/data/clawbrain/logs")
DEFAULT_ARTIFACTS_DIR = Path("/data/clawbrain/artifacts")
DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"
DEFAULT_QUEUE_NAME = "clawbrain:tasks"
DEFAULT_STATUS_REDIS_KEY = "clawbrain:agent_status:latest"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ClawBrain AutoTuneAgent")
    parser.add_argument(
        "--config-dir",
        default=os.environ.get("CLAWBRAIN_CONFIG_DIR", str(DEFAULT_CONFIG_DIR)),
    )
    parser.add_argument(
        "--logs-dir",
        default=os.environ.get("CLAWBRAIN_LOGS_DIR", str(DEFAULT_LOGS_DIR)),
    )
    parser.add_argument(
        "--artifacts-dir",
        default=os.environ.get("CLAWBRAIN_ARTIFACTS_DIR", str(DEFAULT_ARTIFACTS_DIR)),
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
        "--status-redis-key",
        default=os.environ.get("CLAWBRAIN_AGENT_STATUS_REDIS_KEY", DEFAULT_STATUS_REDIS_KEY),
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=int(os.environ.get("CLAWBRAIN_AUTOTUNE_INTERVAL_SEC", "180")),
    )
    parser.add_argument(
        "--max-log-files",
        type=int,
        default=int(os.environ.get("CLAWBRAIN_AUTOTUNE_MAX_LOG_FILES", "40")),
    )
    parser.add_argument("--once", action="store_true")
    return parser.parse_args()


def _summarize_recent_logs(logs_dir: Path, max_files: int) -> dict[str, Any]:
    if not logs_dir.is_dir():
        return {"log_files_count": 0, "total_log_size_bytes": 0, "newest_logs": []}

    entries = sorted(
        [path for path in logs_dir.glob("*.log") if path.is_file()],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    newest = entries[: max(1, max_files)]

    files_info: list[dict[str, Any]] = []
    total = 0
    for path in newest:
        stat = path.stat()
        total += stat.st_size
        files_info.append(
            {
                "name": path.name,
                "size_bytes": stat.st_size,
                "mtime": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            }
        )

    return {
        "log_files_count": len(entries),
        "total_log_size_bytes": total,
        "newest_logs": files_info[:10],
    }


def _load_status_snapshot(queue: RedisQueue, status_redis_key: str) -> dict[str, Any]:
    try:
        raw = queue.client.get(status_redis_key)
    except Exception:
        return {}
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _build_recommendations(
    *,
    policy: Any | None,
    queue_depth: int,
    status_snapshot: dict[str, Any],
    logs_summary: dict[str, Any],
) -> list[str]:
    recommendations: list[str] = []
    missing_agents = status_snapshot.get("missing_agents") if isinstance(status_snapshot.get("missing_agents"), list) else []

    if queue_depth >= 5:
        recommendations.append("Queue depth >= 5: activar profile reinforce para escalar runner-coder-r2 y runner-builder-r2.")
    elif queue_depth > 0:
        recommendations.append("Hay tareas en cola: monitorear tiempos y mantener AutoTuneAgent activo.")
    else:
        recommendations.append("Cola en cero: estado estable.")

    if missing_agents:
        recommendations.append(f"Agentes faltantes reportados por maintainer: {', '.join(str(x) for x in missing_agents)}.")
    else:
        recommendations.append("Maintainer reporta agentes requeridos en linea.")

    if policy is None:
        recommendations.append("No se pudo cargar policy activa, validar /data/clawbrain/config/policy.yaml.")
    else:
        repos_allowed = list(getattr(policy, "repos_allowed", []))
        stacks_allowed = list(getattr(policy, "stacks_allowed", []))
        if not repos_allowed:
            recommendations.append("Policy con repos_allowed vacio (DENY ALL): no se ejecutaran tareas de repo hasta definir allowlist.")
        if not stacks_allowed:
            recommendations.append("Policy con stacks_allowed vacio (DENY ALL deploy stacks).")

    if logs_summary.get("log_files_count", 0) == 0:
        recommendations.append("No hay logs de tareas aun: ejecuta un task de smoke test para poblar auditoria.")
    elif logs_summary.get("total_log_size_bytes", 0) > 30 * 1024 * 1024:
        recommendations.append("Logs recientes >30MB: planificar rotacion/retencion de logs.")

    return recommendations


def _markdown_report(report: dict[str, Any]) -> str:
    metrics = report.get("metrics", {})
    status = report.get("status", {})
    recs = report.get("recommendations", [])
    lines = [
        "# AutoTuneAgent Report",
        "",
        f"- generated_at: {report.get('generated_at')}",
        f"- queue_depth: {metrics.get('queue_depth')}",
        f"- agents_alive: {status.get('agents_alive')}",
        f"- agents_missing: {status.get('agents_missing')}",
        f"- log_files_count: {metrics.get('log_files_count')}",
        "",
        "## Recommendations",
    ]
    for item in recs:
        lines.append(f"- {item}")
    lines.append("")
    return "\n".join(lines)


def _write_report(artifacts_dir: Path, report: dict[str, Any]) -> tuple[Path, Path]:
    out_dir = (artifacts_dir / "auto_improve").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    ts_token = utc_now().strftime("%Y%m%dT%H%M%SZ")
    report_json_path = out_dir / f"report_{ts_token}.json"
    report_md_path = out_dir / f"report_{ts_token}.md"
    latest_json_path = out_dir / "latest_report.json"
    latest_md_path = out_dir / "latest_report.md"

    report_json_path.write_text(json.dumps(report, ensure_ascii=True, indent=2), encoding="utf-8")
    report_md_path.write_text(_markdown_report(report), encoding="utf-8")
    latest_json_path.write_text(json.dumps(report, ensure_ascii=True, indent=2), encoding="utf-8")
    latest_md_path.write_text(_markdown_report(report), encoding="utf-8")
    return latest_json_path, latest_md_path


def run_cycle(args: argparse.Namespace) -> int:
    config_dir = Path(args.config_dir).resolve()
    logs_dir = Path(args.logs_dir).resolve()
    artifacts_dir = Path(args.artifacts_dir).resolve()

    queue = RedisQueue(redis_url=args.redis_url, queue_name=args.queue_name)
    queue.ping()

    policy = None
    try:
        policy = load_policy(config_dir / "policy.yaml")
    except (PolicyError, OSError) as exc:
        print(f"[autotune][WARN] failed to load policy: {exc}")

    queue_depth = queue.length()
    status_snapshot = _load_status_snapshot(queue, str(args.status_redis_key))
    logs_summary = _summarize_recent_logs(logs_dir, max_files=args.max_log_files)
    recommendations = _build_recommendations(
        policy=policy,
        queue_depth=queue_depth,
        status_snapshot=status_snapshot,
        logs_summary=logs_summary,
    )

    agents = status_snapshot.get("agents")
    agents_alive = 0
    agents_missing = 0
    if isinstance(agents, list):
        for item in agents:
            if isinstance(item, dict):
                if bool(item.get("alive")):
                    agents_alive += 1
                else:
                    agents_missing += 1

    report = {
        "generated_at": utc_now_iso(),
        "agent": "AutoTuneAgent",
        "metrics": {
            "queue_depth": queue_depth,
            "log_files_count": logs_summary.get("log_files_count", 0),
            "total_log_size_bytes": logs_summary.get("total_log_size_bytes", 0),
            "newest_logs": logs_summary.get("newest_logs", []),
        },
        "status": {
            "agents_alive": agents_alive,
            "agents_missing": agents_missing,
            "maintainer_snapshot_ts": status_snapshot.get("ts"),
        },
        "recommendations": recommendations,
    }

    latest_json_path, latest_md_path = _write_report(artifacts_dir, report)
    queue.publish_heartbeat(
        agent="AutoTuneAgent",
        linux_user=os.environ.get("CLAWBRAIN_AUTOTUNE_LINUX_USER", "codex"),
        ttl_seconds=max(20, int(args.interval_seconds) * 2),
        extra={
            "state": "idle",
            "report_json": str(latest_json_path),
            "report_md": str(latest_md_path),
        },
    )
    print(
        f"[autotune] generated_at={report['generated_at']} queue_depth={queue_depth} "
        f"report={latest_json_path}"
    )
    return 0


def main() -> int:
    args = parse_args()
    interval = max(30, int(args.interval_seconds))

    while True:
        try:
            code = run_cycle(args)
        except QueueError as exc:
            print(f"[autotune][FAIL] redis error: {exc}")
            code = 1
        except OSError as exc:
            print(f"[autotune][FAIL] io error: {exc}")
            code = 1
        except Exception as exc:  # noqa: BLE001
            print(f"[autotune][FAIL] unexpected: {exc}")
            code = 1

        if args.once:
            return code

        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
