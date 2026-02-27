export const TRISTATE_VALUES = ["auto", "yes", "no"] as const;
export const PRIORITY_VALUES = ["critical", "high", "normal", "low"] as const;

const UX_KEYWORDS = [
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
];

const NO_UX_HINTS = [
  "api",
  "backend",
  "worker",
  "queue",
  "redis",
  "db",
  "database",
  "migracion",
  "migrate",
];

const DEPLOY_KEYWORDS = ["deploy", "despliegue", "produccion", "production", "release", "rollout"];

const CRITICAL_PRIORITY_KEYWORDS = [
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
];

const HIGH_PRIORITY_KEYWORDS = ["urgent", "urgente", "asap", "hotfix", "hoy", "prioridad alta"];

const VALIDATION_KEYWORDS = [
  "validar",
  "validacion",
  "verificar",
  "test",
  "tests",
  "qa",
  "probar",
  "build",
  "regresion",
];

export class PMOrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PMOrchestratorError";
  }
}

export interface PMInterview {
  repo: string;
  goal: string;
  current_state: string;
  deliverables: string;
  constraints: string;
  definition_done: string;
  priority: (typeof PRIORITY_VALUES)[number];
  needs_ux: (typeof TRISTATE_VALUES)[number];
  needs_builder: (typeof TRISTATE_VALUES)[number];
}

export interface PMTaskDraft {
  order: number;
  agent: string;
  task_type: string;
  request_text: string;
  reason: string;
  command?: string | null;
}

export interface PMPlan {
  interview: PMInterview;
  summary: string;
  tasks: PMTaskDraft[];
  notes: string[];
}

export interface PMSimpleTranslation {
  source_text: string;
  interview_payload: Record<string, unknown>;
  notes: string[];
}

function normalizeText(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return fallback;
}

export function normalizeTristate(value: unknown, fallback: (typeof TRISTATE_VALUES)[number] = "auto"): (typeof TRISTATE_VALUES)[number] {
  const raw = normalizeText(value, fallback).toLowerCase() as (typeof TRISTATE_VALUES)[number];
  if (TRISTATE_VALUES.includes(raw)) {
    return raw;
  }
  throw new PMOrchestratorError(
    `invalid tristate value '${String(value)}'. expected one of ${JSON.stringify(TRISTATE_VALUES)}`,
  );
}

export function normalizePriority(value: unknown, fallback: (typeof PRIORITY_VALUES)[number] = "normal"): (typeof PRIORITY_VALUES)[number] {
  const raw = normalizeText(value, fallback).toLowerCase() as (typeof PRIORITY_VALUES)[number];
  if (PRIORITY_VALUES.includes(raw)) {
    return raw;
  }
  throw new PMOrchestratorError(
    `invalid priority '${String(value)}'. expected one of ${JSON.stringify(PRIORITY_VALUES)}`,
  );
}

function containsAny(text: string, keywords: string[]): boolean {
  const low = text.toLowerCase();
  return keywords.some((keyword) => low.includes(keyword));
}

export function buildInterviewFromPayload(payload: Record<string, unknown>): PMInterview {
  const repo = normalizeText(payload.repo);
  const goal = normalizeText(payload.goal ?? payload.request_text);
  if (!repo) {
    throw new PMOrchestratorError("repo is required");
  }
  if (!goal) {
    throw new PMOrchestratorError("goal is required");
  }

  return {
    repo,
    goal,
    current_state: normalizeText(
      payload.current_state,
      "No contexto tecnico adicional del usuario.",
    ),
    deliverables: normalizeText(
      payload.deliverables,
      "Cambios en codigo mas resumen corto de implementacion.",
    ),
    constraints: normalizeText(
      payload.constraints,
      "No romper comportamiento existente. Cambios minimos y revisables.",
    ),
    definition_done: normalizeText(
      payload.definition_done,
      "Implementado, validado y documentado en resumen final.",
    ),
    priority: normalizePriority(payload.priority, "normal"),
    needs_ux: normalizeTristate(payload.needs_ux, "auto"),
    needs_builder: normalizeTristate(payload.needs_builder, "auto"),
  };
}

function inferPriorityFromSimpleText(text: string): (typeof PRIORITY_VALUES)[number] {
  if (containsAny(text, CRITICAL_PRIORITY_KEYWORDS)) {
    return "critical";
  }
  if (containsAny(text, HIGH_PRIORITY_KEYWORDS)) {
    return "high";
  }
  return "normal";
}

function inferNeedsUxFromSimpleText(text: string): (typeof TRISTATE_VALUES)[number] {
  if (containsAny(text, UX_KEYWORDS)) {
    return "yes";
  }
  return "auto";
}

function inferNeedsBuilderFromSimpleText(text: string): (typeof TRISTATE_VALUES)[number] {
  if (containsAny(text, VALIDATION_KEYWORDS)) {
    return "yes";
  }
  return "auto";
}

function simpleDeliverables(needsUx: (typeof TRISTATE_VALUES)[number]): string {
  if (needsUx === "yes") {
    return "Implementacion tecnica + ajuste UX/UI solicitado + validacion de flujo final.";
  }
  return "Implementacion tecnica solicitada + validacion funcional final.";
}

export function translateSimpleRequest(params: {
  repo: string;
  text: string;
  priority?: string | null;
  needs_ux?: string | null;
  needs_builder?: string | null;
}): PMSimpleTranslation {
  const repo = normalizeText(params.repo);
  const text = normalizeText(params.text);
  if (!repo) {
    throw new PMOrchestratorError("repo is required for simple translation");
  }
  if (!text) {
    throw new PMOrchestratorError("text is required for simple translation");
  }

  const inferredPriority = inferPriorityFromSimpleText(text);
  const inferredNeedsUx = inferNeedsUxFromSimpleText(text);
  const inferredNeedsBuilder = inferNeedsBuilderFromSimpleText(text);

  const finalPriority = normalizeText(params.priority)
    ? normalizePriority(params.priority, inferredPriority)
    : inferredPriority;
  const finalNeedsUx = normalizeText(params.needs_ux)
    ? normalizeTristate(params.needs_ux, inferredNeedsUx)
    : inferredNeedsUx;
  const finalNeedsBuilder = normalizeText(params.needs_builder)
    ? normalizeTristate(params.needs_builder, inferredNeedsBuilder)
    : inferredNeedsBuilder;

  const notes = [
    `priority inferred as ${inferredPriority}`,
    `needs_ux inferred as ${inferredNeedsUx}`,
    `needs_builder inferred as ${inferredNeedsBuilder}`,
  ];
  if (normalizeText(params.priority)) {
    notes.push("priority overridden by explicit input");
  }
  if (normalizeText(params.needs_ux)) {
    notes.push("needs_ux overridden by explicit input");
  }
  if (normalizeText(params.needs_builder)) {
    notes.push("needs_builder overridden by explicit input");
  }

  return {
    source_text: text,
    interview_payload: {
      repo,
      goal: text,
      current_state: `Solicitud original en lenguaje simple: ${text}`,
      deliverables: simpleDeliverables(finalNeedsUx),
      constraints: "No romper comportamiento existente. Cambios minimos y revisables.",
      definition_done: "Se cumple el objetivo solicitado, sin regresiones visibles y con verificacion final.",
      priority: finalPriority,
      needs_ux: finalNeedsUx,
      needs_builder: finalNeedsBuilder,
    },
    notes,
  };
}

function inferNeedsUx(interview: PMInterview): boolean {
  if (interview.needs_ux === "yes") {
    return true;
  }
  if (interview.needs_ux === "no") {
    return false;
  }

  const joined = [
    interview.goal,
    interview.current_state,
    interview.deliverables,
    interview.definition_done,
  ].join(" ");

  if (containsAny(joined, UX_KEYWORDS)) {
    return true;
  }
  if (containsAny(joined, NO_UX_HINTS)) {
    return false;
  }
  return false;
}

function inferNeedsBuilder(interview: PMInterview): boolean {
  if (interview.needs_builder === "yes") {
    return true;
  }
  if (interview.needs_builder === "no") {
    return false;
  }
  return true;
}

function baseContext(interview: PMInterview): string {
  return (
    "[PM TRANSLATED BRIEF]\n" +
    `Repo: ${interview.repo}\n` +
    `Priority: ${interview.priority}\n` +
    `Goal: ${interview.goal}\n` +
    `Current state: ${interview.current_state}\n` +
    `Deliverables: ${interview.deliverables}\n` +
    `Constraints: ${interview.constraints}\n` +
    `Definition of done: ${interview.definition_done}\n`
  );
}

function coderRequest(interview: PMInterview): string {
  return (
    `${baseContext(interview)}\n` +
    "Agent mission:\n" +
    "- Implement the requested solution in code.\n" +
    "- Keep scope tight and avoid unrelated refactors.\n" +
    "- Add/update tests only when needed for behavior confidence.\n" +
    "- Leave a concise technical summary for next agents.\n"
  );
}

function uxRequest(interview: PMInterview): string {
  return (
    `${baseContext(interview)}\n` +
    "Agent mission:\n" +
    "- Refine UX/UI flow based on the stated goal.\n" +
    "- Ensure responsive behavior for desktop and mobile.\n" +
    "- Keep visual consistency with existing product patterns.\n" +
    "- Report UX acceptance checks completed.\n"
  );
}

function builderRequest(interview: PMInterview): string {
  return (
    `${baseContext(interview)}\n` +
    "Agent mission:\n" +
    "- Validate implementation with build/test/verification commands.\n" +
    "- Capture failures with clear reproduction details.\n" +
    "- Confirm Definition of done with objective checks.\n" +
    "- Produce final release-readiness summary.\n"
  );
}

export function buildPmPlan(interview: PMInterview): PMPlan {
  const needsUx = inferNeedsUx(interview);
  const needsBuilder = inferNeedsBuilder(interview);

  const tasks: PMTaskDraft[] = [];
  const notes: string[] = [];

  tasks.push({
    order: 1,
    agent: "CoderAgent",
    task_type: "codex",
    request_text: coderRequest(interview),
    reason: "Primary implementation owner",
  });

  let order = 2;
  if (needsUx) {
    tasks.push({
      order,
      agent: "UXAgent",
      task_type: "codex",
      request_text: uxRequest(interview),
      reason: "UX/UI refinement requested or inferred from scope",
    });
    order += 1;
  }

  if (needsBuilder) {
    tasks.push({
      order,
      agent: "BuilderAgent",
      task_type: "codex",
      request_text: builderRequest(interview),
      reason: "Independent validation and release readiness checks",
    });
  }

  const joined = [
    interview.goal,
    interview.current_state,
    interview.deliverables,
    interview.definition_done,
  ].join(" ");
  if (containsAny(joined, DEPLOY_KEYWORDS)) {
    notes.push("Deploy intent detected. DeployerAgent was not auto-enqueued by PM flow.");
  }

  const flow = tasks.map((task) => task.agent).join(" -> ");
  return {
    interview,
    summary: `PM plan ready. flow=${flow} priority=${interview.priority}`,
    tasks,
    notes,
  };
}

export function planToTaskPayloads(plan: PMPlan): Record<string, unknown>[] {
  return plan.tasks.map((task) => ({
    type: task.task_type,
    repo: plan.interview.repo,
    agent: task.agent,
    request_text: task.request_text,
    command: task.command ?? null,
    constraints: {
      pm_orchestrated: true,
      pm_order: task.order,
      pm_reason: task.reason,
    },
  }));
}

export async function dispatchPmPlan(params: {
  plan: PMPlan;
  createTask: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const queued: Record<string, unknown>[] = [];
  const failed: Record<string, unknown>[] = [];

  for (const payload of planToTaskPayloads(params.plan)) {
    const constraints = payload.constraints as Record<string, unknown>;
    const order = Number(constraints.pm_order ?? 0);
    const agent = String(payload.agent ?? "");

    try {
      const response = await params.createTask(payload);
      queued.push({
        order,
        agent,
        task_id: String(response.task_id ?? ""),
        status: String(response.status ?? "queued"),
      });
    } catch (error) {
      failed.push({
        order,
        agent,
        error: String(error),
      });
    }
  }

  return {
    summary: failed.length === 0 ? "dispatch_completed" : "dispatch_partial_failure",
    queued_count: queued.length,
    failed_count: failed.length,
    queued,
    failed,
  };
}
