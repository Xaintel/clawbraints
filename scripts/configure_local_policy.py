#!/usr/bin/env python3
"""Configure local policy repos and codex commands for mobile mode."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import yaml

REPO_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CODEX_CMD_RE = re.compile(r"^codex exec(\s|$)")


def _parse_repos(raw: str) -> list[str]:
    values: list[str] = []
    for item in raw.split(","):
        repo = item.strip()
        if not repo:
            continue
        if not REPO_NAME_RE.fullmatch(repo):
            raise ValueError(f"invalid repo name: {repo}")
        if repo not in values:
            values.append(repo)
    if not values:
        raise ValueError("repos list is empty")
    return values


def _codex_command(repo: str, projects_root: str) -> str:
    return (
        f"codex exec --skip-git-repo-check --sandbox workspace-write "
        f"-C {projects_root}/{repo} -"
    )


def _dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    for item in values:
        if item not in out:
            out.append(item)
    return out


def _rewrite_agent_commands(
    *,
    agent_cfg: dict[str, Any],
    repos: list[str],
    projects_root: str,
) -> None:
    commands = agent_cfg.get("commands_whitelist")
    if not isinstance(commands, list):
        return

    preserved = [
        value
        for value in commands
        if isinstance(value, str) and not CODEX_CMD_RE.match(value.strip())
    ]
    codex_values = [_codex_command(repo, projects_root) for repo in repos]
    agent_cfg["commands_whitelist"] = _dedupe([*preserved, *codex_values])


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure local policy repos and codex commands.")
    parser.add_argument(
        "--policy-file",
        required=True,
        help="Path to active policy.yaml file to patch",
    )
    parser.add_argument(
        "--repos",
        required=True,
        help="Comma-separated repo names allowed in local mode (e.g. demo,clawbrain-brain,claw-jira-app)",
    )
    parser.add_argument(
        "--projects-root",
        default="/srv/projects",
        help="Projects root inside containers (default: /srv/projects)",
    )
    args = parser.parse_args()

    policy_path = Path(args.policy_file).expanduser().resolve()
    if not policy_path.is_file():
        raise SystemExit(f"[FAIL] policy file not found: {policy_path}")

    repos = _parse_repos(args.repos)
    projects_root = args.projects_root.rstrip("/")
    if not projects_root.startswith("/"):
        raise SystemExit(f"[FAIL] projects_root must be absolute: {projects_root}")

    raw = yaml.safe_load(policy_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SystemExit(f"[FAIL] invalid policy format in {policy_path}")

    raw["repos_allowed"] = repos
    paths = raw.get("paths")
    if isinstance(paths, dict):
        paths["projects_root"] = projects_root

    agents = raw.get("agents")
    if isinstance(agents, dict):
        for value in agents.values():
            if isinstance(value, dict):
                _rewrite_agent_commands(
                    agent_cfg=value,
                    repos=repos,
                    projects_root=projects_root,
                )

    policy_path.write_text(
        yaml.safe_dump(raw, sort_keys=False, allow_unicode=False),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "ok": True,
                "policy_file": str(policy_path),
                "repos_allowed": repos,
                "projects_root": projects_root,
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
