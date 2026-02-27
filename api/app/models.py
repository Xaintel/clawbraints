#!/usr/bin/env python3
"""Pydantic models for ClawBrain API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class TaskCreateRequest(BaseModel):
    type: Literal["command", "codex"] = "command"
    repo: str = Field(min_length=1)
    agent: str = Field(min_length=1)
    command: str | None = None
    prompt: str | None = None
    request_text: str | None = None

    @model_validator(mode="after")
    def validate_payload(self) -> "TaskCreateRequest":
        self.repo = self.repo.strip()
        self.agent = self.agent.strip()
        self.command = self.command.strip() if isinstance(self.command, str) else self.command
        self.prompt = self.prompt.strip() if isinstance(self.prompt, str) else self.prompt
        self.request_text = (
            self.request_text.strip() if isinstance(self.request_text, str) else self.request_text
        )

        if self.type == "command" and not self.command:
            raise ValueError("command is required when type=command")
        if not (self.request_text or self.prompt):
            raise ValueError("request_text or prompt is required")
        return self


class TaskCreateResponse(BaseModel):
    task_id: str
    status: str


class TaskResponse(BaseModel):
    id: str
    session_id: str | None
    repo: str
    agent: str
    status: str
    request_text: str
    created_at: str
    started_at: str | None
    finished_at: str | None
    exit_code: int | None
    log_path: str
    artifacts_dir: str | None
    summary_text: str | None


class TaskLogsResponse(BaseModel):
    task_id: str
    log_path: str
    lines: list[str]
    content_b64: str
    truncated: bool


class RepoMemoryResponse(BaseModel):
    repo: str
    memory_path: str
    content: str


class RepoMemoryPutRequest(BaseModel):
    content: str = Field(default="")


class IdeTaskCreateRequest(TaskCreateRequest):
    constraints: dict[str, Any] = Field(default_factory=dict)


class IdeApplyInstructions(BaseModel):
    mode: Literal["manual_confirm"] = "manual_confirm"
    steps: list[str] = Field(default_factory=list)


class IdeTaskCreateResponse(BaseModel):
    task_id: str
    status: str
    apply_instructions: IdeApplyInstructions


class IdeTaskResponse(TaskResponse):
    artifacts: list[str] = Field(default_factory=list)
    apply_instructions: IdeApplyInstructions


class ArtifactItem(BaseModel):
    name: str
    size_bytes: int


class IdeArtifactsListResponse(BaseModel):
    task_id: str
    artifacts_dir: str | None
    artifacts: list[ArtifactItem] = Field(default_factory=list)
