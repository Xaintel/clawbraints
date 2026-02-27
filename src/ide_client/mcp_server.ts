import fs from "node:fs";
import path from "node:path";

import { applyPatchLocal, ClawBrainIDEClient, IDEClientError } from "./client";
import { ConfigError, loadConfig } from "./config";
import {
  PMOrchestratorError,
  buildInterviewFromPayload,
  buildPmPlan,
  dispatchPmPlan,
  translateSimpleRequest,
} from "./pm_orchestrator";

class MCPProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPProtocolError";
  }
}

function jsonDumps(value: unknown): string {
  return JSON.stringify(value);
}

function readLine(fd: number): string | null {
  const bytes: number[] = [];
  const chunk = Buffer.alloc(1);

  while (true) {
    const read = fs.readSync(fd, chunk, 0, 1, null);
    if (read === 0) {
      if (bytes.length === 0) {
        return null;
      }
      break;
    }

    bytes.push(chunk[0]);
    if (chunk[0] === 0x0a) {
      break;
    }
  }

  return Buffer.from(bytes).toString("utf-8");
}

function readExact(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, buffer, offset, size - offset, null);
    if (read === 0) {
      throw new MCPProtocolError("unexpected EOF while reading body");
    }
    offset += read;
  }
  return buffer;
}

function readMessage(): Record<string, unknown> | null {
  const headers: Record<string, string> = {};

  while (true) {
    const line = readLine(0);
    if (line === null) {
      return null;
    }

    if (line === "\r\n" || line === "\n") {
      break;
    }

    const decoded = line.trim();
    if (!decoded) {
      break;
    }

    const separator = decoded.indexOf(":");
    if (separator < 0) {
      continue;
    }

    const key = decoded.slice(0, separator).trim().toLowerCase();
    const value = decoded.slice(separator + 1).trim();
    headers[key] = value;
  }

  if (!("content-length" in headers)) {
    throw new MCPProtocolError("missing Content-Length header");
  }

  const contentLength = Number(headers["content-length"]);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new MCPProtocolError("invalid Content-Length header");
  }

  const body = readExact(0, contentLength);
  try {
    const parsed = JSON.parse(body.toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MCPProtocolError("JSON-RPC payload must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MCPProtocolError) {
      throw error;
    }
    throw new MCPProtocolError(`invalid JSON message: ${String(error)}`);
  }
}

function writeMessage(payload: Record<string, unknown>): void {
  const body = Buffer.from(jsonDumps(payload), "utf-8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  fs.writeSync(1, header);
  fs.writeSync(1, body);
}

function toolList(): Record<string, unknown>[] {
  return [
    {
      name: "clawbrain.create_task",
      description: "Create an IDE task on ClawBrain server",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["command", "codex"], default: "codex" },
          repo: { type: "string" },
          agent: { type: "string" },
          request_text: { type: "string" },
          command: { type: "string" },
          prompt: { type: "string" },
          constraints: { type: "object" },
        },
        required: ["repo", "agent", "request_text"],
      },
    },
    {
      name: "clawbrain.get_task",
      description: "Get a task from IDE API",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
    {
      name: "clawbrain.get_logs",
      description: "Fetch task logs",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          max_bytes: { type: "integer", default: 8192 },
        },
        required: ["task_id"],
      },
    },
    {
      name: "clawbrain.get_diff",
      description: "Download task diff.patch",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
    {
      name: "clawbrain.list_agents",
      description: "List available agents",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "clawbrain.apply_patch_local",
      description: "Apply patch on local git workspace with explicit confirmation",
      inputSchema: {
        type: "object",
        properties: {
          patch_path: { type: "string" },
          repo_path: { type: "string", default: "." },
          yes: { type: "boolean", default: false },
          index: { type: "boolean", default: false },
        },
        required: ["patch_path"],
      },
    },
    {
      name: "clawbrain.pm_plan",
      description: "Build PM interview plan and translated task breakdown",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          goal: { type: "string" },
          current_state: { type: "string" },
          deliverables: { type: "string" },
          constraints: { type: "string" },
          definition_done: { type: "string" },
          priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
          needs_ux: { type: "string", enum: ["auto", "yes", "no"] },
          needs_builder: { type: "string", enum: ["auto", "yes", "no"] },
        },
        required: ["repo", "goal"],
      },
    },
    {
      name: "clawbrain.pm_dispatch",
      description: "Build PM plan and dispatch translated tasks to execution agents",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          goal: { type: "string" },
          current_state: { type: "string" },
          deliverables: { type: "string" },
          constraints: { type: "string" },
          definition_done: { type: "string" },
          priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
          needs_ux: { type: "string", enum: ["auto", "yes", "no"] },
          needs_builder: { type: "string", enum: ["auto", "yes", "no"] },
        },
        required: ["repo", "goal"],
      },
    },
    {
      name: "clawbrain.pm_translate_simple",
      description: "Translate a simple user phrase to PM interview payload and plan",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          text: { type: "string" },
          priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
          needs_ux: { type: "string", enum: ["auto", "yes", "no"] },
          needs_builder: { type: "string", enum: ["auto", "yes", "no"] },
        },
        required: ["repo", "text"],
      },
    },
    {
      name: "clawbrain.pm_translate_and_dispatch_simple",
      description: "Translate simple phrase to PM plan and dispatch tasks",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          text: { type: "string" },
          priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
          needs_ux: { type: "string", enum: ["auto", "yes", "no"] },
          needs_builder: { type: "string", enum: ["auto", "yes", "no"] },
        },
        required: ["repo", "text"],
      },
    },
  ];
}

function resultText(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: jsonDumps(payload) }],
  };
}

function errorText(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function buildClient(): ClawBrainIDEClient {
  const config = loadConfig({ requireToken: true });
  return new ClawBrainIDEClient(config);
}

function pmPayload(args: Record<string, unknown>): Record<string, unknown> {
  return {
    repo: String(args.repo ?? "").trim(),
    goal: String(args.goal ?? args.request_text ?? "").trim(),
    current_state: String(args.current_state ?? "").trim(),
    deliverables: String(args.deliverables ?? "").trim(),
    constraints: String(args.constraints ?? "").trim(),
    definition_done: String(args.definition_done ?? "").trim(),
    priority: String(args.priority ?? "").trim(),
    needs_ux: String(args.needs_ux ?? "").trim(),
    needs_builder: String(args.needs_builder ?? "").trim(),
  };
}

function simplePmPayload(args: Record<string, unknown>): Record<string, unknown> {
  return {
    repo: String(args.repo ?? "").trim(),
    text: String(args.text ?? args.request_text ?? "").trim(),
    priority: String(args.priority ?? "").trim(),
    needs_ux: String(args.needs_ux ?? "").trim(),
    needs_builder: String(args.needs_builder ?? "").trim(),
  };
}

async function toolCall(name: string, args: Record<string, unknown>, client: ClawBrainIDEClient): Promise<Record<string, unknown>> {
  if (name === "clawbrain.create_task") {
    return resultText(
      await client.createTask({
        type: String(args.type ?? "codex"),
        repo: String(args.repo ?? "").trim(),
        agent: String(args.agent ?? "").trim(),
        request_text: String(args.request_text ?? "").trim(),
        command: args.command,
        prompt: args.prompt,
        constraints: args.constraints && typeof args.constraints === "object" && !Array.isArray(args.constraints)
          ? (args.constraints as Record<string, unknown>)
          : {},
      }),
    );
  }

  if (name === "clawbrain.get_task") {
    return resultText(await client.getTask(String(args.task_id ?? "").trim()));
  }

  if (name === "clawbrain.get_logs") {
    return resultText(
      await client.getLogs(
        String(args.task_id ?? "").trim(),
        Number(args.max_bytes ?? 8192),
      ),
    );
  }

  if (name === "clawbrain.get_diff") {
    const diff = await client.getDiff(String(args.task_id ?? "").trim());
    return { content: [{ type: "text", text: diff }] };
  }

  if (name === "clawbrain.list_agents") {
    return resultText(await client.listAgents());
  }

  if (name === "clawbrain.apply_patch_local") {
    return resultText(
      applyPatchLocal({
        patchPath: String(args.patch_path ?? "").trim(),
        repoPath: String(args.repo_path ?? ".").trim() || ".",
        yes: Boolean(args.yes),
        index: Boolean(args.index),
      }),
    );
  }

  if (name === "clawbrain.pm_plan") {
    const interview = buildInterviewFromPayload(pmPayload(args));
    const plan = buildPmPlan(interview);
    return resultText({ plan });
  }

  if (name === "clawbrain.pm_dispatch") {
    const interview = buildInterviewFromPayload(pmPayload(args));
    const plan = buildPmPlan(interview);
    const dispatch = await dispatchPmPlan({
      plan,
      createTask: async (payload) => client.createTask(payload),
    });
    return resultText({ plan, dispatch });
  }

  if (name === "clawbrain.pm_translate_simple") {
    const payload = simplePmPayload(args);
    const translation = translateSimpleRequest({
      repo: String(payload.repo),
      text: String(payload.text),
      priority: String(payload.priority || "") || null,
      needs_ux: String(payload.needs_ux || "") || null,
      needs_builder: String(payload.needs_builder || "") || null,
    });
    const interview = buildInterviewFromPayload(translation.interview_payload);
    const plan = buildPmPlan(interview);
    return resultText({ translation, plan });
  }

  if (name === "clawbrain.pm_translate_and_dispatch_simple") {
    const payload = simplePmPayload(args);
    const translation = translateSimpleRequest({
      repo: String(payload.repo),
      text: String(payload.text),
      priority: String(payload.priority || "") || null,
      needs_ux: String(payload.needs_ux || "") || null,
      needs_builder: String(payload.needs_builder || "") || null,
    });
    const interview = buildInterviewFromPayload(translation.interview_payload);
    const plan = buildPmPlan(interview);
    const dispatch = await dispatchPmPlan({
      plan,
      createTask: async (payload2) => client.createTask(payload2),
    });
    return resultText({ translation, plan, dispatch });
  }

  throw new IDEClientError(`unknown tool: ${name}`);
}

async function handleRequest(msg: Record<string, unknown>, client: ClawBrainIDEClient): Promise<Record<string, unknown> | null> {
  const method = msg.method;
  const reqId = msg.id;
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
    ? (msg.params as Record<string, unknown>)
    : {};

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: reqId,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "clawbrain-mcp", version: "0.1.0" },
        instructions: "Use clawbrain.* tools to orchestrate tasks and local patch apply.",
      },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id: reqId, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: reqId,
      result: { tools: toolList() },
    };
  }

  if (method === "tools/call") {
    const toolName = String(params.name ?? "").trim();
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};

    try {
      const result = await toolCall(toolName, args, client);
      return { jsonrpc: "2.0", id: reqId, result };
    } catch (error) {
      if (error instanceof IDEClientError || error instanceof ConfigError || error instanceof PMOrchestratorError) {
        return { jsonrpc: "2.0", id: reqId, result: errorText(error.message) };
      }
      return { jsonrpc: "2.0", id: reqId, result: errorText(String(error)) };
    }
  }

  if (reqId === undefined || reqId === null) {
    return null;
  }

  return {
    jsonrpc: "2.0",
    id: reqId,
    error: { code: -32601, message: `Method not found: ${String(method)}` },
  };
}

async function main(): Promise<number> {
  let client: ClawBrainIDEClient;
  try {
    client = buildClient();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[FAIL] ${String(error)}`);
    return 1;
  }

  while (true) {
    let msg: Record<string, unknown> | null;
    try {
      msg = readMessage();
    } catch (error) {
      const payload = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: String(error) },
      };
      writeMessage(payload);
      continue;
    }

    if (msg === null) {
      return 0;
    }

    const response = await handleRequest(msg, client);
    if (response) {
      writeMessage(response);
    }
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}
