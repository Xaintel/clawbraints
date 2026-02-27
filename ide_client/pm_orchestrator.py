#!/usr/bin/env python3
"""Project-manager style planning and task dispatch for ClawBrain IDE tools."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


TRISTATE_VALUES = {"auto", "yes", "no"}
PRIORITY_VALUES = {"critical", "high", "normal", "low"}

_UX_KEYWORDS = {
    "ui",
    "ux",
    "frontend",
    "front-end",
    "css",
    "layout",
    "responsive",
    "accesibilidad",
    "accesible",
    "pantalla",
    "menu",
    "diseno",
    "visual",
}

_NO_UX_HINTS = {
    "api",
    "backend",
    "worker",
    "queue",
    "redis",
    "db",
    "database",
    "migracion",
    "migrate",
}

_DEPLOY_KEYWORDS = {
    "deploy",
    "despliegue",
    "produccion",
    "production",
    "release",
    "rollout",
}

_CRITICAL_PRIORITY_KEYWORDS = {
    "critical",
    "critico",
    "critica",
    "caido",
    "caida",
    "incidente",
    "bloqueado",
    "bloquea",
    "outage",
    "produccion rota",
}

_HIGH_PRIORITY_KEYWORDS = {
    "urgent",
    "urgente",
    "asap",
    "hotfix",
    "hoy",
    "prioridad alta",
}

_VALIDATION_KEYWORDS = {
    "validar",
    "validacion",
    "verificar",
    "test",
    "tests",
    "qa",
    "probar",
    "build",
    "regresion",
}


class PMOrchestratorError(RuntimeError):
    """Raised when PM plan payloads are invalid."""


@dataclass(frozen=True)
class PMInterview:
    repo: str
    goal: str
    current_state: str
    deliverables: str
    constraints: str
    definition_done: str
    priority: str
    needs_ux: str = "auto"
    needs_builder: str = "auto"

    def as_dict(self) -> dict[str, Any]:
        return {
            "repo": self.repo,
            "goal": self.goal,
            "current_state": self.current_state,
            "deliverables": self.deliverables,
            "constraints": self.constraints,
            "definition_done": self.definition_done,
            "priority": self.priority,
            "needs_ux": self.needs_ux,
            "needs_builder": self.needs_builder,
        }


@dataclass(frozen=True)
class PMTaskDraft:
    order: int
    agent: str
    task_type: str
    request_text: str
    reason: str
    command: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "order": self.order,
            "agent": self.agent,
            "type": self.task_type,
            "reason": self.reason,
            "command": self.command,
            "request_text": self.request_text,
        }


@dataclass(frozen=True)
class PMPlan:
    interview: PMInterview
    summary: str
    tasks: list[PMTaskDraft]
    notes: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "interview": self.interview.as_dict(),
            "summary": self.summary,
            "tasks": [task.as_dict() for task in self.tasks],
            "notes": list(self.notes),
        }


@dataclass(frozen=True)
class PMSimpleTranslation:
    source_text: str
    interview_payload: dict[str, Any]
    notes: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_text": self.source_text,
            "interview_payload": dict(self.interview_payload),
            "notes": list(self.notes),
        }


def _normalize_text(value: Any, *, default: str = "") -> str:
    if isinstance(value, str):
        cleaned = value.strip()
        if cleaned:
            return cleaned
    return default


def normalize_tristate(value: Any, *, default: str = "auto") -> str:
    raw = _normalize_text(value, default=default).lower()
    if raw in TRISTATE_VALUES:
        return raw
    raise PMOrchestratorError(
        f"invalid tristate value '{value}'. expected one of {sorted(TRISTATE_VALUES)}"
    )


def normalize_priority(value: Any, *, default: str = "normal") -> str:
    raw = _normalize_text(value, default=default).lower()
    if raw in PRIORITY_VALUES:
        return raw
    raise PMOrchestratorError(
        f"invalid priority '{value}'. expected one of {sorted(PRIORITY_VALUES)}"
    )


def build_interview_from_payload(payload: dict[str, Any]) -> PMInterview:
    repo = _normalize_text(payload.get("repo"))
    goal = _normalize_text(payload.get("goal") or payload.get("request_text"))
    if not repo:
        raise PMOrchestratorError("repo is required")
    if not goal:
        raise PMOrchestratorError("goal is required")

    return PMInterview(
        repo=repo,
        goal=goal,
        current_state=_normalize_text(
            payload.get("current_state"),
            default="No contexto tecnico adicional del usuario.",
        ),
        deliverables=_normalize_text(
            payload.get("deliverables"),
            default="Cambios en codigo mas resumen corto de implementacion.",
        ),
        constraints=_normalize_text(
            payload.get("constraints"),
            default="No romper comportamiento existente. Cambios minimos y revisables.",
        ),
        definition_done=_normalize_text(
            payload.get("definition_done"),
            default="Implementado, validado y documentado en resumen final.",
        ),
        priority=normalize_priority(payload.get("priority"), default="normal"),
        needs_ux=normalize_tristate(payload.get("needs_ux"), default="auto"),
        needs_builder=normalize_tristate(payload.get("needs_builder"), default="auto"),
    )


def _infer_priority_from_simple_text(text: str) -> str:
    low = text.lower()
    if _contains_any(low, _CRITICAL_PRIORITY_KEYWORDS):
        return "critical"
    if _contains_any(low, _HIGH_PRIORITY_KEYWORDS):
        return "high"
    return "normal"


def _infer_needs_ux_from_simple_text(text: str) -> str:
    if _contains_any(text.lower(), _UX_KEYWORDS):
        return "yes"
    return "auto"


def _infer_needs_builder_from_simple_text(text: str) -> str:
    low = text.lower()
    if _contains_any(low, _VALIDATION_KEYWORDS):
        return "yes"
    return "auto"


def _simple_deliverables(needs_ux: str) -> str:
    if needs_ux == "yes":
        return (
            "Implementacion tecnica + ajuste UX/UI solicitado + validacion de flujo final."
        )
    return "Implementacion tecnica solicitada + validacion funcional final."


def translate_simple_request(
    *,
    repo: str,
    text: str,
    priority: str | None = None,
    needs_ux: str | None = None,
    needs_builder: str | None = None,
) -> PMSimpleTranslation:
    repo_clean = _normalize_text(repo)
    text_clean = _normalize_text(text)
    if not repo_clean:
        raise PMOrchestratorError("repo is required for simple translation")
    if not text_clean:
        raise PMOrchestratorError("text is required for simple translation")

    inferred_priority = _infer_priority_from_simple_text(text_clean)
    inferred_needs_ux = _infer_needs_ux_from_simple_text(text_clean)
    inferred_needs_builder = _infer_needs_builder_from_simple_text(text_clean)

    final_priority = (
        normalize_priority(priority, default=inferred_priority)
        if _normalize_text(priority)
        else inferred_priority
    )
    final_needs_ux = (
        normalize_tristate(needs_ux, default=inferred_needs_ux)
        if _normalize_text(needs_ux)
        else inferred_needs_ux
    )
    final_needs_builder = (
        normalize_tristate(needs_builder, default=inferred_needs_builder)
        if _normalize_text(needs_builder)
        else inferred_needs_builder
    )

    notes = [
        f"priority inferred as {inferred_priority}",
        f"needs_ux inferred as {inferred_needs_ux}",
        f"needs_builder inferred as {inferred_needs_builder}",
    ]
    if _normalize_text(priority):
        notes.append("priority overridden by explicit input")
    if _normalize_text(needs_ux):
        notes.append("needs_ux overridden by explicit input")
    if _normalize_text(needs_builder):
        notes.append("needs_builder overridden by explicit input")

    payload = {
        "repo": repo_clean,
        "goal": text_clean,
        "current_state": f"Solicitud original en lenguaje simple: {text_clean}",
        "deliverables": _simple_deliverables(final_needs_ux),
        "constraints": "No romper comportamiento existente. Cambios minimos y revisables.",
        "definition_done": (
            "Se cumple el objetivo solicitado, sin regresiones visibles y con verificacion final."
        ),
        "priority": final_priority,
        "needs_ux": final_needs_ux,
        "needs_builder": final_needs_builder,
    }
    return PMSimpleTranslation(
        source_text=text_clean,
        interview_payload=payload,
        notes=notes,
    )


def _contains_any(text: str, keywords: set[str]) -> bool:
    low = text.lower()
    return any(token in low for token in keywords)


def _infer_needs_ux(interview: PMInterview) -> bool:
    if interview.needs_ux == "yes":
        return True
    if interview.needs_ux == "no":
        return False

    joined = " ".join(
        [
            interview.goal,
            interview.current_state,
            interview.deliverables,
            interview.definition_done,
        ]
    )
    if _contains_any(joined, _UX_KEYWORDS):
        return True
    if _contains_any(joined, _NO_UX_HINTS):
        return False
    return False


def _infer_needs_builder(interview: PMInterview) -> bool:
    if interview.needs_builder == "yes":
        return True
    if interview.needs_builder == "no":
        return False
    return True


def _base_context(interview: PMInterview) -> str:
    return (
        "[PM TRANSLATED BRIEF]\n"
        f"Repo: {interview.repo}\n"
        f"Priority: {interview.priority}\n"
        f"Goal: {interview.goal}\n"
        f"Current state: {interview.current_state}\n"
        f"Deliverables: {interview.deliverables}\n"
        f"Constraints: {interview.constraints}\n"
        f"Definition of done: {interview.definition_done}\n"
    )


def _coder_request(interview: PMInterview) -> str:
    return (
        f"{_base_context(interview)}\n"
        "Agent mission:\n"
        "- Implement the requested solution in code.\n"
        "- Keep scope tight and avoid unrelated refactors.\n"
        "- Add/update tests only when needed for behavior confidence.\n"
        "- Leave a concise technical summary for next agents.\n"
    )


def _ux_request(interview: PMInterview) -> str:
    return (
        f"{_base_context(interview)}\n"
        "Agent mission:\n"
        "- Refine UX/UI flow based on the stated goal.\n"
        "- Ensure responsive behavior for desktop and mobile.\n"
        "- Keep visual consistency with existing product patterns.\n"
        "- Report UX acceptance checks completed.\n"
    )


def _builder_request(interview: PMInterview) -> str:
    return (
        f"{_base_context(interview)}\n"
        "Agent mission:\n"
        "- Validate implementation with build/test/verification commands.\n"
        "- Capture failures with clear reproduction details.\n"
        "- Confirm Definition of done with objective checks.\n"
        "- Produce final release-readiness summary.\n"
    )


def build_pm_plan(interview: PMInterview) -> PMPlan:
    needs_ux = _infer_needs_ux(interview)
    needs_builder = _infer_needs_builder(interview)

    tasks: list[PMTaskDraft] = []
    notes: list[str] = []
    order = 1

    tasks.append(
        PMTaskDraft(
            order=order,
            agent="CoderAgent",
            task_type="codex",
            request_text=_coder_request(interview),
            reason="Primary implementation owner",
        )
    )
    order += 1

    if needs_ux:
        tasks.append(
            PMTaskDraft(
                order=order,
                agent="UXAgent",
                task_type="codex",
                request_text=_ux_request(interview),
                reason="UX/UI refinement requested or inferred from scope",
            )
        )
        order += 1

    if needs_builder:
        tasks.append(
            PMTaskDraft(
                order=order,
                agent="BuilderAgent",
                task_type="codex",
                request_text=_builder_request(interview),
                reason="Independent validation and release readiness checks",
            )
        )
        order += 1

    joined = " ".join(
        [
            interview.goal,
            interview.current_state,
            interview.deliverables,
            interview.definition_done,
        ]
    )
    if _contains_any(joined, _DEPLOY_KEYWORDS):
        notes.append(
            "Deploy intent detected. DeployerAgent was not auto-enqueued by PM flow."
        )

    flow = " -> ".join(task.agent for task in tasks)
    summary = f"PM plan ready. flow={flow} priority={interview.priority}"
    return PMPlan(interview=interview, summary=summary, tasks=tasks, notes=notes)


def plan_to_task_payloads(plan: PMPlan) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for task in plan.tasks:
        payload = {
            "type": task.task_type,
            "repo": plan.interview.repo,
            "agent": task.agent,
            "request_text": task.request_text,
            "command": task.command,
            "constraints": {
                "pm_orchestrated": True,
                "pm_order": task.order,
                "pm_reason": task.reason,
            },
        }
        payloads.append(payload)
    return payloads


def dispatch_pm_plan(
    *,
    plan: PMPlan,
    create_task: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    queued: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    for payload in plan_to_task_payloads(plan):
        order = int(payload["constraints"]["pm_order"])
        agent = str(payload.get("agent", ""))
        try:
            response = create_task(payload)
            task_id = _normalize_text(response.get("task_id"))
            status = _normalize_text(response.get("status"), default="queued")
            queued.append(
                {
                    "order": order,
                    "agent": agent,
                    "task_id": task_id,
                    "status": status,
                }
            )
        except Exception as exc:  # noqa: BLE001
            failed.append(
                {
                    "order": order,
                    "agent": agent,
                    "error": str(exc),
                }
            )

    return {
        "summary": "dispatch_completed" if not failed else "dispatch_partial_failure",
        "queued_count": len(queued),
        "failed_count": len(failed),
        "queued": queued,
        "failed": failed,
    }
