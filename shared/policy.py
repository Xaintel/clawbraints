#!/usr/bin/env python3
"""Strict policy loader and validators for ClawBrain."""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Dict, List, Tuple

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator


class PolicyError(Exception):
    """Raised when policy validation fails."""


class PathsConfig(BaseModel):
    projects_root: str
    data_root: str
    allowed_write_roots: List[str] = Field(default_factory=list)

    @field_validator("projects_root", "data_root")
    @classmethod
    def _validate_root_path(cls, value: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("path must be a non-empty string")
        if not value.startswith("/"):
            raise ValueError("path must be absolute")
        return value.strip()

    @field_validator("allowed_write_roots")
    @classmethod
    def _validate_write_roots(cls, roots: List[str]) -> List[str]:
        normalized: List[str] = []
        for root in roots:
            if not isinstance(root, str) or not root.strip():
                raise ValueError("allowed_write_roots entries must be non-empty strings")
            entry = root.strip()
            if not entry.startswith("/"):
                raise ValueError("allowed_write_roots entries must be absolute paths")
            normalized.append(entry)
        return normalized


class AgentConfig(BaseModel):
    linux_user: str
    allow_sudo: bool = False
    commands_whitelist: List[str] = Field(default_factory=list)
    sudo_commands_allowed: List[str] = Field(default_factory=list)

    @field_validator("linux_user")
    @classmethod
    def _validate_linux_user(cls, value: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("linux_user must be a non-empty string")
        return value.strip()


class PolicyConfig(BaseModel):
    version: int
    paths: PathsConfig
    repos_allowed: List[str] = Field(default_factory=list)
    agents: Dict[str, AgentConfig]
    stacks_allowed: List[str] = Field(default_factory=list)

    @field_validator("repos_allowed", "stacks_allowed")
    @classmethod
    def _validate_name_list(cls, items: List[str]) -> List[str]:
        normalized: List[str] = []
        for item in items:
            if not isinstance(item, str):
                raise ValueError("list entries must be strings")
            value = item.strip()
            if not value:
                continue
            normalized.append(value)
        return normalized


def load_policy(policy_path: str | Path) -> PolicyConfig:
    path = Path(policy_path)
    if not path.is_file():
        raise PolicyError(f"policy file not found: {path}")

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise PolicyError(f"invalid YAML policy ({path}): {exc}") from exc
    except OSError as exc:
        raise PolicyError(f"failed reading policy ({path}): {exc}") from exc

    if not isinstance(raw, dict):
        raise PolicyError(f"policy must be a YAML mapping: {path}")

    try:
        policy = PolicyConfig.model_validate(raw)
    except ValidationError as exc:
        raise PolicyError(f"invalid policy schema ({path}): {exc}") from exc

    if not policy.agents:
        raise PolicyError("policy.agents cannot be empty")

    return policy


def normalize_command(command: str) -> Tuple[str, List[str]]:
    if not isinstance(command, str) or not command.strip():
        raise PolicyError("command must be a non-empty string")

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError as exc:
        raise PolicyError(f"invalid command syntax: {exc}") from exc

    if not tokens:
        raise PolicyError("empty command after normalization")

    normalized = " ".join(tokens)
    return normalized, tokens


def validate_repo_allowed(policy: PolicyConfig, repo_name: str) -> str:
    repo = repo_name.strip() if isinstance(repo_name, str) else ""
    if not repo:
        raise PolicyError("repo name must be a non-empty string")

    if not policy.repos_allowed:
        raise PolicyError("repos_allowed is empty: DENY ALL")

    if repo not in policy.repos_allowed:
        raise PolicyError(f"repo not allowed by policy: {repo}")

    return repo


def validate_agent(policy: PolicyConfig, agent_name: str) -> AgentConfig:
    name = agent_name.strip() if isinstance(agent_name, str) else ""
    if not name:
        raise PolicyError("agent name must be a non-empty string")

    agent = policy.agents.get(name)
    if agent is None:
        raise PolicyError(f"agent not declared in policy: {name}")

    return agent


def _normalize_allowed_commands(commands: List[str], context: str) -> Dict[str, List[str]]:
    normalized: Dict[str, List[str]] = {}
    for command in commands:
        cmd_norm, cmd_tokens = normalize_command(command)
        normalized[cmd_norm] = cmd_tokens
    if not normalized:
        raise PolicyError(f"{context} is empty: DENY ALL")
    return normalized


def validate_command_whitelist(policy: PolicyConfig, agent_name: str, command: str) -> List[str]:
    agent = validate_agent(policy, agent_name)
    normalized_command, tokens = normalize_command(command)
    allowed = _normalize_allowed_commands(
        agent.commands_whitelist,
        f"commands_whitelist for {agent_name}",
    )

    if normalized_command not in allowed:
        raise PolicyError(
            f"command not in exact whitelist for {agent_name}: '{normalized_command}'"
        )

    return tokens


def validate_sudo_command(policy: PolicyConfig, agent_name: str, command: str) -> str:
    agent = validate_agent(policy, agent_name)
    if not agent.allow_sudo:
        raise PolicyError(f"agent {agent_name} is not allowed to use sudo")

    normalized_command, _ = normalize_command(command)
    allowed = _normalize_allowed_commands(
        agent.sudo_commands_allowed,
        f"sudo_commands_allowed for {agent_name}",
    )

    if normalized_command not in allowed:
        raise PolicyError(
            f"sudo command not in exact whitelist for {agent_name}: '{normalized_command}'"
        )

    return normalized_command


def resolve_repo_path(policy: PolicyConfig, repo_name: str) -> Path:
    repo = validate_repo_allowed(policy, repo_name)
    projects_root = Path(policy.paths.projects_root).resolve()
    resolved = (projects_root / repo).resolve()

    if resolved == projects_root or not resolved.is_relative_to(projects_root):
        raise PolicyError(f"resolved repo path escapes projects_root: {resolved}")

    return resolved


def validate_paths_write(policy: PolicyConfig, target_path: str | Path) -> Path:
    target = Path(target_path).resolve()
    allowed_roots = [Path(root).resolve() for root in policy.paths.allowed_write_roots]

    if not allowed_roots:
        raise PolicyError("allowed_write_roots is empty: DENY ALL writes")

    for root in allowed_roots:
        if target == root or target.is_relative_to(root):
            return target

    raise PolicyError(f"path not allowed for write: {target}")


def validate_stack(policy: PolicyConfig, stack_name: str) -> str:
    stack = stack_name.strip() if isinstance(stack_name, str) else ""
    if not stack:
        raise PolicyError("stack name must be a non-empty string")

    if not policy.stacks_allowed:
        raise PolicyError("stacks_allowed is empty: DENY ALL")

    if stack not in policy.stacks_allowed:
        raise PolicyError(f"stack not allowed by policy: {stack}")

    return stack

