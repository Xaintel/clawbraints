import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth } from "../auth";
import { QueueError, PolicyError } from "../errors";
import { resolveLogPath } from "../logging";
import { taskCreateRequestSchema } from "../models";
import {
  readPolicyOrError,
  getMemoryPath,
  ensurePathUnder,
} from "../storage";
import {
  validateAgent,
  validateCommandWhitelist,
  validatePathsWrite,
  validateRepoAllowed,
  resolveRepoPath,
} from "../policy";
import type { AppContext } from "../types";

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

function ensureAuthorized(request: FastifyRequest, reply: FastifyReply): boolean {
  return requireAuth(request, reply);
}

export function registerTaskRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.post("/tasks", async (request, reply) => {
    if (!ensureAuthorized(request, reply)) {
      return;
    }

    const parsedPayload = taskCreateRequestSchema.safeParse(request.body ?? {});
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
    } catch (error) {
      reply.code(500).send({ detail: `failed to create task in DB: ${String(error)}` });
      return;
    }

    const payloadToQueue = {
      task_id: taskId,
      type: payload.type,
      repo,
      agent,
      command,
      request_text: requestText,
      prompt: payload.prompt,
      db_path: context.settings.dbPath,
      created_at: createdAt,
    };

    try {
      await context.queue.ping();
      await context.queue.enqueue(payloadToQueue);
    } catch (error) {
      if (error instanceof QueueError) {
        reply.code(503).send({ detail: `failed to enqueue task: ${error.message}` });
      } else {
        reply.code(503).send({ detail: `failed to enqueue task: ${String(error)}` });
      }
      return;
    }

    reply.send({ task_id: taskId, status: "queued" });
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

    reply.send(row);
  });

  app.get<{ Params: { taskId: string }; Querystring: { max_bytes?: string } }>(
    "/tasks/:taskId/logs",
    async (request, reply) => {
      if (!ensureAuthorized(request, reply)) {
        return;
      }

      const row = context.store.getTask(request.params.taskId);
      if (!row) {
        reply.code(404).send({ detail: "task not found" });
        return;
      }

      if (!row.log_path || !row.log_path.trim()) {
        reply.code(500).send({ detail: "task has no log path" });
        return;
      }

      let logPath: string;
      try {
        logPath = ensurePathUnder(context.settings.logsDir, row.log_path);
      } catch {
        reply.code(500).send({ detail: "invalid log path" });
        return;
      }

      if (!fs.existsSync(logPath) || !fs.statSync(logPath).isFile()) {
        reply.code(404).send({ detail: "log not found" });
        return;
      }

      const maxBytes = parseMaxBytes(request.query.max_bytes, 8192, 1, 262_144);
      const raw = fs.readFileSync(logPath);
      const truncated = raw.length > maxBytes;
      const tail = truncated ? raw.subarray(raw.length - maxBytes) : raw;
      const content = tail.toString("utf-8");
      const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

      reply.send({
        task_id: request.params.taskId,
        log_path: logPath,
        lines,
        content_b64: Buffer.from(content, "utf-8").toString("base64"),
        truncated,
      });
    },
  );

  app.get<{ Params: { repo: string } }>("/repos/:repo/memory", async (request, reply) => {
    if (!ensureAuthorized(request, reply)) {
      return;
    }

    let policy;
    let memoryPath: string;
    try {
      policy = readPolicyOrError(context.settings);
      validateRepoAllowed(policy, request.params.repo);
      memoryPath = getMemoryPath(context.settings, request.params.repo);
    } catch (error) {
      reply.code(policyErrorToHttpStatus(error)).send({ detail: String(error) });
      return;
    }

    if (!fs.existsSync(memoryPath) || !fs.statSync(memoryPath).isFile()) {
      reply.code(404).send({ detail: "memory file not found" });
      return;
    }

    const content = fs.readFileSync(memoryPath, "utf-8");
    reply.send({
      repo: request.params.repo,
      memory_path: memoryPath,
      content,
    });
  });

  app.put<{ Params: { repo: string }; Body: { content?: string } }>(
    "/repos/:repo/memory",
    async (request, reply) => {
      if (!ensureAuthorized(request, reply)) {
        return;
      }

      const content = String(request.body?.content ?? "");

      let policy;
      let memoryPath: string;
      try {
        policy = readPolicyOrError(context.settings);
        validateRepoAllowed(policy, request.params.repo);
        memoryPath = getMemoryPath(context.settings, request.params.repo);
        validatePathsWrite(policy, memoryPath);
      } catch (error) {
        reply.code(policyErrorToHttpStatus(error)).send({ detail: String(error) });
        return;
      }

      fs.writeFileSync(memoryPath, content, "utf-8");
      const contentHash = createHash("sha256").update(content, "utf-8").digest("hex");
      context.store.upsertRepoMemoryIndex({
        repo: request.params.repo,
        memoryPath,
        updatedAt: new Date().toISOString(),
        contentHash,
      });

      reply.send({
        repo: request.params.repo,
        memory_path: memoryPath,
        content,
      });
    },
  );
}
