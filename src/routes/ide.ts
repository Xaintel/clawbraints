import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import yaml from "js-yaml";

import { requireAuth } from "../auth";
import { PolicyError, QueueError } from "../errors";
import { resolveLogPath } from "../logging";
import { buildApplyInstructions, ideTaskCreateRequestSchema } from "../models";
import { ensurePathUnder, readPolicyOrError } from "../storage";
import {
  validateAgent,
  validateCommandWhitelist,
  validateRepoAllowed,
  resolveRepoPath,
} from "../policy";
import type { AppContext } from "../types";

function ensureAuthorized(request: FastifyRequest, reply: FastifyReply): boolean {
  return requireAuth(request, reply);
}

function policyErrorToHttpStatus(error: unknown): number {
  return error instanceof PolicyError ? 400 : 500;
}

function parseMaxBytes(rawValue: unknown, fallback: number, minValue: number, maxValue: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maxValue, Math.max(minValue, Math.floor(parsed)));
}

function loadAgentsCatalog(configDir: string): Record<string, Record<string, unknown>> {
  const filePath = path.join(configDir, "agents.yaml");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return {};
  }

  try {
    const payload = yaml.load(fs.readFileSync(filePath, "utf-8"));
    if (!payload || typeof payload !== "object") {
      return {};
    }

    const agentsBlock = (payload as { agents?: unknown }).agents;
    if (!agentsBlock || typeof agentsBlock !== "object") {
      return {};
    }

    const catalog: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of Object.entries(agentsBlock as Record<string, unknown>)) {
      if (typeof name === "string" && value && typeof value === "object") {
        catalog[name] = value as Record<string, unknown>;
      }
    }
    return catalog;
  } catch {
    return {};
  }
}

function resolveArtifactsDir(context: AppContext, artifactsDirRaw?: string | null): string | null {
  if (!artifactsDirRaw) {
    return null;
  }

  const artifactsDir = ensurePathUnder(context.settings.artifactsDir, artifactsDirRaw);
  if (!fs.existsSync(artifactsDir)) {
    return null;
  }
  if (!fs.statSync(artifactsDir).isDirectory()) {
    throw new Error("invalid artifacts_dir");
  }
  return artifactsDir;
}

function listArtifactItems(artifactsDir: string | null): Array<{ name: string; size_bytes: number }> {
  if (!artifactsDir) {
    return [];
  }

  const items: Array<{ name: string; size_bytes: number }> = [];

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const rel = path.relative(artifactsDir, absolute).split(path.sep).join("/");
      const sizeBytes = fs.statSync(absolute).size;
      items.push({ name: rel, size_bytes: sizeBytes });
    }
  };

  walk(artifactsDir);
  items.sort((left, right) => left.name.localeCompare(right.name));
  return items;
}

export function registerIdeRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/agents", async (request, reply) => {
    if (!ensureAuthorized(request, reply)) {
      return;
    }

    const policy = readPolicyOrError(context.settings);
    const catalog = loadAgentsCatalog(context.settings.configDir);

    const agents = Object.keys(policy.agents)
      .sort((left, right) => left.localeCompare(right))
      .map((agentName) => {
        const policyConfig = policy.agents[agentName];
        const extra = catalog[agentName] ?? {};
        return {
          name: agentName,
          linux_user: policyConfig.linux_user,
          allow_sudo: Boolean(policyConfig.allow_sudo),
          role: String(extra.role ?? ""),
          description: String(extra.description ?? ""),
          model: String(extra.model ?? ""),
          skills: Array.isArray(extra.skills) ? extra.skills : [],
        };
      });

    reply.send({ agents });
  });

  app.post("/tasks", async (request, reply) => {
    if (!ensureAuthorized(request, reply)) {
      return;
    }

    const parsedPayload = ideTaskCreateRequestSchema.safeParse(request.body ?? {});
    if (!parsedPayload.success) {
      reply.code(400).send({ detail: parsedPayload.error.flatten() });
      return;
    }

    let policy;
    try {
      policy = readPolicyOrError(context.settings);
    } catch (error) {
      reply.code(503).send({ detail: String(error) });
      return;
    }

    const payload = parsedPayload.data;
    const repo = payload.repo.trim();
    const agent = payload.agent.trim();
    const requestText = (payload.request_text ?? payload.prompt ?? "").trim();
    let command = payload.command?.trim() ?? "";

    try {
      validateAgent(policy, agent);
      validateRepoAllowed(policy, repo);
      const repoPath = resolveRepoPath(policy, repo);

      if (payload.type === "command") {
        if (!command) {
          throw new PolicyError("command is required when type=command");
        }
        validateCommandWhitelist(policy, agent, command);
      } else {
        if (!command) {
          command = `codex exec --skip-git-repo-check --sandbox workspace-write -C ${repoPath} -`;
        }
        validateCommandWhitelist(policy, agent, command);
      }
    } catch (error) {
      reply.code(policyErrorToHttpStatus(error)).send({ detail: String(error) });
      return;
    }

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const logPath = resolveLogPath(taskId, context.settings.logsDir);

    try {
      context.store.createTask({
        taskId,
        sessionId: null,
        repo,
        agent,
        status: "queued",
        requestText,
        logPath,
        createdAt,
      });

      context.store.insertAuditEvent({
        taskId,
        actorType: "user",
        actor: "ide_client",
        action: "ide_task_created",
        detail: {
          type: payload.type,
          repo,
          agent,
          origin: "ide",
        },
      });
    } catch (error) {
      reply.code(500).send({ detail: `failed to create task in DB: ${String(error)}` });
      return;
    }

    try {
      await context.queue.ping();
      await context.queue.enqueue({
        task_id: taskId,
        type: payload.type,
        origin: "ide",
        repo,
        agent,
        command,
        request_text: requestText,
        prompt: payload.prompt,
        constraints: payload.constraints,
        db_path: context.settings.dbPath,
        created_at: createdAt,
      });
    } catch (error) {
      if (error instanceof QueueError) {
        reply.code(503).send({ detail: `failed to enqueue task: ${error.message}` });
      } else {
        reply.code(503).send({ detail: `failed to enqueue task: ${String(error)}` });
      }
      return;
    }

    reply.send({
      task_id: taskId,
      status: "queued",
      apply_instructions: buildApplyInstructions(taskId),
    });
  });

  app.get<{ Params: { taskId: string } }>("/tasks/:taskId", async (request, reply) => {
    if (!ensureAuthorized(request, reply)) {
      return;
    }

    const row = context.store.getTask(request.params.taskId);
    if (!row) {
      reply.code(404).send({ detail: "task not found" });
      return;
    }

    const artifactsDir = resolveArtifactsDir(context, row.artifacts_dir);
    const artifacts = listArtifactItems(artifactsDir).map((item) => item.name);

    reply.send({
      ...row,
      artifacts,
      apply_instructions: buildApplyInstructions(request.params.taskId),
    });
  });

  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/diff", async (request, reply) => {
    if (!ensureAuthorized(request, reply)) {
      return;
    }

    const row = context.store.getTask(request.params.taskId);
    if (!row) {
      reply.code(404).send({ detail: "task not found" });
      return;
    }

    const artifactsDir = resolveArtifactsDir(context, row.artifacts_dir);
    if (!artifactsDir) {
      reply.code(404).send({ detail: "artifacts not found" });
      return;
    }

    const diffPath = ensurePathUnder(artifactsDir, path.join(artifactsDir, "diff.patch"));
    if (!fs.existsSync(diffPath) || !fs.statSync(diffPath).isFile()) {
      reply.code(404).send({ detail: "diff.patch not found" });
      return;
    }

    const content = fs.readFileSync(diffPath, "utf-8");
    reply.type("text/x-diff").send(content);
  });

  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/artifacts", async (request, reply) => {
    if (!ensureAuthorized(request, reply)) {
      return;
    }

    const row = context.store.getTask(request.params.taskId);
    if (!row) {
      reply.code(404).send({ detail: "task not found" });
      return;
    }

    const artifactsDir = resolveArtifactsDir(context, row.artifacts_dir);
    const artifacts = listArtifactItems(artifactsDir);

    reply.send({
      task_id: request.params.taskId,
      artifacts_dir: artifactsDir,
      artifacts,
    });
  });

  app.get<{ Params: { taskId: string; "*": string }; Querystring: { max_bytes?: string } }>(
    "/tasks/:taskId/artifacts/*",
    async (request, reply) => {
      if (!ensureAuthorized(request, reply)) {
        return;
      }

      const row = context.store.getTask(request.params.taskId);
      if (!row) {
        reply.code(404).send({ detail: "task not found" });
        return;
      }

      const artifactsDir = resolveArtifactsDir(context, row.artifacts_dir);
      if (!artifactsDir) {
        reply.code(404).send({ detail: "artifacts not found" });
        return;
      }

      const artifactRel = (request.params["*"] ?? "").trim().replace(/^\/+/, "");
      if (!artifactRel) {
        reply.code(400).send({ detail: "artifact name is required" });
        return;
      }

      const target = ensurePathUnder(artifactsDir, path.join(artifactsDir, artifactRel));
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        reply.code(404).send({ detail: "artifact not found" });
        return;
      }

      const maxBytes = parseMaxBytes(request.query.max_bytes, 10_485_760, 1, 104_857_600);
      const size = fs.statSync(target).size;
      if (size > maxBytes) {
        reply
          .code(413)
          .send({ detail: `artifact too large (${size} bytes > max_bytes=${maxBytes})` });
        return;
      }

      const data = fs.readFileSync(target);
      reply
        .type("application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${path.basename(target)}"`)
        .header("X-Clawbrain-Artifact-Path", artifactRel)
        .send(data);
    },
  );
}
