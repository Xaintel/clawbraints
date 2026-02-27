import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { IDEClientConfig } from "./config";

export class IDEClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IDEClientError";
  }
}

export class HTTPErrorDetail extends IDEClientError {
  constructor(
    public readonly statusCode: number,
    public readonly statusMessage: string,
    public readonly responseBody: string,
  ) {
    super(
      responseBody
        ? `HTTP ${statusCode}: ${statusMessage} (${responseBody})`
        : `HTTP ${statusCode}: ${statusMessage}`,
    );
  }
}

async function request(params: {
  serverUrl: string;
  token: string;
  timeoutSec: number;
  method: string;
  path: string;
  jsonBody?: Record<string, unknown>;
  query?: Record<string, unknown>;
  accept?: string;
}): Promise<{ body: Buffer; contentType: string }> {
  const url = new URL(`${params.serverUrl}${params.path}`);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    "X-Clawbrain-Token": params.token,
    Accept: params.accept ?? "application/json",
    "User-Agent": "clawbrain-ide/0.1",
  };

  let bodyText: string | undefined;
  if (params.jsonBody) {
    bodyText = JSON.stringify(params.jsonBody);
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, params.timeoutSec) * 1000);

  try {
    const response = await fetch(url.toString(), {
      method: params.method,
      headers,
      body: bodyText,
      signal: controller.signal,
    });

    const arrayBuffer = await response.arrayBuffer();
    const body = Buffer.from(arrayBuffer);

    if (!response.ok) {
      throw new HTTPErrorDetail(
        response.status,
        response.statusText,
        body.toString("utf-8"),
      );
    }

    return {
      body,
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    if (error instanceof HTTPErrorDetail) {
      throw error;
    }
    throw new IDEClientError(`request failed: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObject(raw: Buffer, context: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw.toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new IDEClientError(`expected JSON object response for ${context}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof IDEClientError) {
      throw error;
    }
    throw new IDEClientError(`invalid JSON response for ${context}: ${String(error)}`);
  }
}

export class ClawBrainIDEClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly timeoutSec: number;

  constructor(config: IDEClientConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.timeoutSec = config.timeoutSec;
  }

  private async requestJson(
    method: string,
    targetPath: string,
    options?: {
      jsonBody?: Record<string, unknown>;
      query?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const response = await request({
      serverUrl: this.serverUrl,
      token: this.token,
      timeoutSec: this.timeoutSec,
      method,
      path: targetPath,
      jsonBody: options?.jsonBody,
      query: options?.query,
      accept: "application/json",
    });
    return parseJsonObject(response.body, `${method} ${targetPath}`);
  }

  async listAgents(): Promise<Record<string, unknown>> {
    return this.requestJson("GET", "/api/ide/agents");
  }

  async createTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson("POST", "/api/ide/tasks", { jsonBody: payload });
  }

  async getTask(taskId: string): Promise<Record<string, unknown>> {
    return this.requestJson("GET", `/api/ide/tasks/${taskId}`);
  }

  async getLogs(taskId: string, maxBytes = 8192): Promise<Record<string, unknown>> {
    return this.requestJson("GET", `/api/tasks/${taskId}/logs`, {
      query: { max_bytes: maxBytes },
    });
  }

  async getDiff(taskId: string): Promise<string> {
    const response = await request({
      serverUrl: this.serverUrl,
      token: this.token,
      timeoutSec: this.timeoutSec,
      method: "GET",
      path: `/api/ide/tasks/${taskId}/diff`,
      accept: "text/x-diff",
    });
    return response.body.toString("utf-8");
  }

  async listArtifacts(taskId: string): Promise<Record<string, unknown>> {
    return this.requestJson("GET", `/api/ide/tasks/${taskId}/artifacts`);
  }

  async getArtifact(taskId: string, artifactName: string): Promise<Buffer> {
    const safeName = artifactName.trim().replace(/^\/+/, "");
    if (!safeName) {
      throw new IDEClientError("artifact_name cannot be empty");
    }

    const response = await request({
      serverUrl: this.serverUrl,
      token: this.token,
      timeoutSec: this.timeoutSec,
      method: "GET",
      path: `/api/ide/tasks/${taskId}/artifacts/${safeName}`,
      accept: "application/octet-stream",
    });
    return response.body;
  }

  async waitTask(params: {
    taskId: string;
    timeoutSec: number;
    pollIntervalSec: number;
    successStatuses: Set<string>;
    errorStatuses: Set<string>;
  }): Promise<Record<string, unknown>> {
    const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000;
    let lastPayload: Record<string, unknown> | null = null;

    while (Date.now() < deadline) {
      const payload = await this.getTask(params.taskId);
      lastPayload = payload;
      const status = String(payload.status ?? "");
      if (params.successStatuses.has(status)) {
        return payload;
      }
      if (params.errorStatuses.has(status)) {
        throw new IDEClientError(`task finished in status=${status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0.1, params.pollIntervalSec) * 1000));
    }

    if (lastPayload) {
      throw new IDEClientError(
        `timeout waiting task ${params.taskId}. last status=${String(lastPayload.status ?? "")}`,
      );
    }
    throw new IDEClientError(`timeout waiting task ${params.taskId}`);
  }
}

export function applyPatchLocal(params: {
  patchPath: string;
  repoPath: string;
  yes: boolean;
  index: boolean;
}): Record<string, unknown> {
  const patchPath = path.resolve(params.patchPath);
  const repoPath = path.resolve(params.repoPath);

  if (!fs.existsSync(patchPath) || !fs.statSync(patchPath).isFile()) {
    throw new IDEClientError(`patch file not found: ${patchPath}`);
  }
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new IDEClientError(`repo path not found: ${repoPath}`);
  }

  const patchText = fs.readFileSync(patchPath, "utf-8");
  if (!patchText.trim()) {
    return {
      applied: false,
      reason: "empty patch",
      repo_path: repoPath,
      patch_path: patchPath,
    };
  }

  const gitCheck = spawnSync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf-8",
  });
  if (gitCheck.status !== 0) {
    throw new IDEClientError(
      `target path is not a git worktree: ${repoPath} (${(gitCheck.stderr ?? "").trim()})`,
    );
  }

  if (!params.yes) {
    const preview = patchText.split(/\r?\n/).slice(0, 20).join("\n");
    // eslint-disable-next-line no-console
    console.log("Patch preview (first 20 lines):");
    // eslint-disable-next-line no-console
    console.log(preview);
    // eslint-disable-next-line no-console
    process.stdout.write("Apply patch locally with git apply? [y/N]: ");
    const input = fs.readFileSync(0, "utf-8").trim().toLowerCase();
    if (input !== "y" && input !== "yes") {
      return {
        applied: false,
        reason: "user_declined",
        repo_path: repoPath,
        patch_path: patchPath,
      };
    }
  }

  const cmd = ["-C", repoPath, "apply"];
  if (params.index) {
    cmd.push("--index");
  }
  cmd.push(patchPath);

  const result = spawnSync("git", cmd, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new IDEClientError(
      `git apply failed (exit=${result.status}): ${String(result.stderr ?? result.stdout ?? "").trim()}`,
    );
  }

  return {
    applied: true,
    repo_path: repoPath,
    patch_path: patchPath,
    index: params.index,
  };
}
