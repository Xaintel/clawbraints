import path from "node:path";
import { spawnSync } from "node:child_process";

import { Command } from "commander";

import { SqliteStore } from "../db";
import { PolicyError, QueueError } from "../errors";
import { appendLog, resolveLogPath } from "../logging";
import { loadPolicy, normalizeCommand, resolveRepoPath, validateAgent, validateCommandWhitelist, validatePathsWrite, validateRepoAllowed, validateStack, type PolicyConfig } from "../policy";
import { RedisQueue } from "../queue";
import { updateMemory } from "./memory";
import { runCodexSkill } from "./skills/codex_skill";

const ALLOWED_AGENTS = [
  "TranslatorAgent",
  "PMAgent",
  "MobileAgent",
  "OCRAgent",
  "QAAgent",
  "CoderAgent",
  "BuilderAgent",
  "UXAgent",
  "DeployerAgent",
] as const;

const ALLOWED_JOB_TYPES = new Set(["command", "codex"]);

const DEFAULT_CONFIG_DIR = "/data/clawbrain/config";
const DEFAULT_DB_PATH = "/data/clawbrain/db/clawbrain.sqlite3";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";
const DEFAULT_QUEUE_NAME = "clawbrain:tasks";
const DEFAULT_LOGS_DIR = "/data/clawbrain/logs";
const DEFAULT_MEMORY_DIR = "/data/clawbrain/memory";
const DEFAULT_ARTIFACTS_DIR = "/data/clawbrain/artifacts";

interface WorkerArgs {
  agent: (typeof ALLOWED_AGENTS)[number];
  once: boolean;
  dbPath: string;
  redisUrl: string;
  queueName: string;
  pollTimeout: number;
  commandTimeout: number;
  maxOutputBytes: number;
  heartbeatInterval: number;
  heartbeatTtl: number;
}

interface JobExecutionResult {
  status: string;
  summary: string;
  exitCode: number | null;
  artifactsDir?: string | null;
}

function parseArgs(argv: string[]): WorkerArgs {
  const program = new Command();
  program
    .requiredOption("--agent <agent>")
    .option("--once", "Process at most one job", false)
    .option("--db-path <path>", "DB path", DEFAULT_DB_PATH)
    .option("--redis-url <url>", "Redis URL", process.env.CLAWBRAIN_REDIS_URL ?? DEFAULT_REDIS_URL)
    .option("--queue-name <name>", "Queue name", process.env.CLAWBRAIN_QUEUE_NAME ?? DEFAULT_QUEUE_NAME)
    .option("--poll-timeout <sec>", "BLPOP timeout (sec)", "5")
    .option(
      "--command-timeout <sec>",
      "Command timeout (sec)",
      process.env.CLAWBRAIN_COMMAND_TIMEOUT_SEC ?? "600",
    )
    .option("--max-output-bytes <bytes>", "Max output bytes", "8192")
    .option(
      "--heartbeat-interval <sec>",
      "Heartbeat interval",
      process.env.CLAWBRAIN_HEARTBEAT_INTERVAL_SEC ?? "10",
    )
    .option(
      "--heartbeat-ttl <sec>",
      "Heartbeat TTL",
      process.env.CLAWBRAIN_HEARTBEAT_TTL_SEC ?? "45",
    );

  program.parse(argv);
  const opts = program.opts<Record<string, string | boolean>>();
  const agent = String(opts.agent ?? "").trim();
  if (!ALLOWED_AGENTS.includes(agent as (typeof ALLOWED_AGENTS)[number])) {
    throw new Error(`invalid --agent '${agent}'`);
  }

  return {
    agent: agent as (typeof ALLOWED_AGENTS)[number],
    once: Boolean(opts.once),
    dbPath: String(opts.dbPath ?? DEFAULT_DB_PATH),
    redisUrl: String(opts.redisUrl ?? DEFAULT_REDIS_URL),
    queueName: String(opts.queueName ?? DEFAULT_QUEUE_NAME),
    pollTimeout: Number(opts.pollTimeout ?? 5),
    commandTimeout: Number(opts.commandTimeout ?? 600),
    maxOutputBytes: Number(opts.maxOutputBytes ?? 8192),
    heartbeatInterval: Number(opts.heartbeatInterval ?? 10),
    heartbeatTtl: Number(opts.heartbeatTtl ?? 45),
  };
}

function safeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const raw = payload[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PolicyError(`missing/invalid payload field '${key}'`);
  }
  return raw.trim();
}

function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf-8");
  if (bytes.length <= maxBytes) {
    return { text: value, truncated: false };
  }
  return {
    text: bytes.subarray(0, maxBytes).toString("utf-8"),
    truncated: true,
  };
}

function ensureWorkerIdentity(policyPath: string, workerAgent: string): { policy: PolicyConfig; workerUser: string } {
  const policy = loadPolicy(policyPath);
  const agentConfig = validateAgent(policy, workerAgent);

  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new Error("worker requires POSIX uid support");
  }
  if (currentUid === 0) {
    throw new Error("worker must never run as root");
  }

  const idResult = spawnSync("id", ["-u", agentConfig.linux_user], { encoding: "utf-8" });
  if (idResult.status !== 0) {
    throw new Error(`linux user not found for ${workerAgent}: ${agentConfig.linux_user}`);
  }
  const expectedUid = Number((idResult.stdout ?? "").trim());
  if (!Number.isFinite(expectedUid)) {
    throw new Error(`invalid uid for ${agentConfig.linux_user}`);
  }

  if (currentUid !== expectedUid) {
    const currentUser = process.env.USER ?? "unknown";
    throw new Error(
      `worker user mismatch for ${workerAgent}: expected ${agentConfig.linux_user}(${expectedUid}), got ${currentUser}(${currentUid})`,
    );
  }

  return { policy, workerUser: agentConfig.linux_user };
}

function policyDenied(params: {
  store: SqliteStore;
  taskId: string;
  workerUser: string;
  logPath: string;
  logsDir: string;
  reason: string;
  commandRaw: string;
}): JobExecutionResult {
  appendLog(params.logPath, `policy_denied: ${params.reason}`, params.logsDir);
  params.store.insertAuditEvent({
    taskId: params.taskId,
    actorType: "system",
    actor: params.workerUser,
    action: "policy_denied",
    detail: { reason: params.reason },
  });
  return {
    status: "failed",
    summary: `FAILED: policy_denied command='${params.commandRaw}'`,
    exitCode: null,
  };
}

function processCommandJob(params: {
  taskId: string;
  repo: string;
  payloadAgent: string;
  commandRaw: string;
  workerAgent: string;
  policy: PolicyConfig;
  store: SqliteStore;
  logPath: string;
  logsDir: string;
  commandTimeout: number;
  maxOutputBytes: number;
}): JobExecutionResult {
  if (params.payloadAgent !== params.workerAgent) {
    throw new PolicyError(
      `worker for ${params.workerAgent} cannot process task for ${params.payloadAgent}`,
    );
  }

  if (!params.commandRaw.trim()) {
    throw new PolicyError("missing/invalid payload field 'command'");
  }

  validateAgent(params.policy, params.payloadAgent);
  validateRepoAllowed(params.policy, params.repo);
  const repoPath = resolveRepoPath(params.policy, params.repo);

  const argv = validateCommandWhitelist(params.policy, params.payloadAgent, params.commandRaw);
  const normalized = normalizeCommand(params.commandRaw).normalized;

  params.store.insertAuditEvent({
    taskId: params.taskId,
    actorType: "agent",
    actor: params.workerAgent,
    action: "command_run",
    detail: {
      command: normalized,
      argv,
      cwd: repoPath,
      timeout_sec: params.commandTimeout,
    },
  });
  appendLog(params.logPath, `command_run: ${normalized}`, params.logsDir);

  const runResult = spawnSync(argv[0], argv.slice(1), {
    cwd: repoPath,
    encoding: "utf-8",
    timeout: params.commandTimeout * 1000,
    maxBuffer: Math.max(1_048_576, params.maxOutputBytes * 8),
  });

  const timedOut = runResult.error?.name === "Error" && String(runResult.error).includes("ETIMEDOUT");
  let exitCode: number;
  let stdoutRaw = String(runResult.stdout ?? "");
  let stderrRaw = String(runResult.stderr ?? "");

  if (timedOut) {
    exitCode = 124;
    stderrRaw = `${stderrRaw}\nCommand timed out.`;
  } else if (runResult.error && runResult.error.message.includes("ENOENT")) {
    exitCode = 127;
    stdoutRaw = "";
    stderrRaw = `Command not found: ${argv[0]} (${runResult.error.message})`;
  } else if (runResult.error) {
    exitCode = 126;
    stdoutRaw = "";
    stderrRaw = `Command execution failed: ${runResult.error.message}`;
  } else {
    exitCode = Number(runResult.status ?? 0);
  }

  const stdout = truncateText(stdoutRaw, params.maxOutputBytes);
  const stderr = truncateText(stderrRaw, params.maxOutputBytes);

  if (stdout.text.trim()) {
    appendLog(params.logPath, `stdout:\n${stdout.text}`, params.logsDir);
  }
  if (stderr.text.trim()) {
    appendLog(params.logPath, `stderr:\n${stderr.text}`, params.logsDir);
  }

  params.store.insertAuditEvent({
    taskId: params.taskId,
    actorType: "agent",
    actor: params.workerAgent,
    action: "command_result",
    detail: {
      exit_code: exitCode,
      timed_out: timedOut,
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
    },
  });

  const status = exitCode === 0 && !timedOut ? "succeeded" : "failed";
  return {
    status,
    summary: `${status.toUpperCase()}: exit_code=${exitCode} command='${normalized}'`,
    exitCode,
  };
}

function processCodexJob(params: {
  taskId: string;
  repo: string;
  payloadAgent: string;
  requestText: string;
  commandRaw: string;
  workerAgent: string;
  workerUser: string;
  policy: PolicyConfig;
  store: SqliteStore;
  logPath: string;
  logsDir: string;
  artifactsDir: string;
  commandTimeout: number;
  maxOutputBytes: number;
}): JobExecutionResult {
  if (params.payloadAgent !== params.workerAgent) {
    throw new PolicyError(
      `worker for ${params.workerAgent} cannot process task for ${params.payloadAgent}`,
    );
  }

  if (
    ![
      "TranslatorAgent",
      "PMAgent",
      "MobileAgent",
      "OCRAgent",
      "QAAgent",
      "CoderAgent",
      "BuilderAgent",
      "UXAgent",
    ].includes(params.payloadAgent)
  ) {
    throw new PolicyError(
      "codex jobs are allowed only for TranslatorAgent, PMAgent, MobileAgent, OCRAgent, QAAgent, CoderAgent, BuilderAgent, or UXAgent",
    );
  }

  const result = runCodexSkill({
    taskId: params.taskId,
    repo: params.repo,
    agent: params.payloadAgent,
    requestText: params.requestText,
    commandRaw: params.commandRaw,
    policy: params.policy,
    store: params.store,
    workerUser: params.workerUser,
    logPath: params.logPath,
    logsDir: params.logsDir,
    artifactsRoot: params.artifactsDir,
    commandTimeoutSec: params.commandTimeout,
    maxOutputBytes: params.maxOutputBytes,
  });

  return {
    status: result.status,
    summary: result.summary,
    exitCode: result.exitCode,
    artifactsDir: result.artifactsDir,
  };
}

function processJob(params: {
  job: Record<string, unknown>;
  workerAgent: string;
  workerUser: string;
  policy: PolicyConfig;
  store: SqliteStore;
  defaultDbPath: string;
  logsDir: string;
  memoryDir: string;
  artifactsDir: string;
  commandTimeout: number;
  maxOutputBytes: number;
}): JobExecutionResult {
  const taskId = requireString(params.job, "task_id");
  const repo = requireString(params.job, "repo");
  const payloadAgent = requireString(params.job, "agent");
  const requestText = requireString(params.job, "request_text");
  const commandRaw = String(params.job.command ?? "").trim();
  const sessionIdRaw = params.job.session_id;
  const stackRaw = params.job.stack;

  const sessionId = typeof sessionIdRaw === "string" && sessionIdRaw.trim() ? sessionIdRaw.trim() : null;
  const stack = typeof stackRaw === "string" && stackRaw.trim() ? stackRaw.trim() : null;

  const dbPath = path.resolve(String(params.job.db_path ?? params.defaultDbPath));
  const jobType = String(params.job.type ?? "command").trim().toLowerCase();

  if (!ALLOWED_JOB_TYPES.has(jobType)) {
    throw new PolicyError(`invalid job type '${jobType}', expected one of ${JSON.stringify(Array.from(ALLOWED_JOB_TYPES))}`);
  }

  const commandTimeout = safeInt(params.job.timeout_sec, params.commandTimeout);
  const maxOutputBytes = safeInt(params.job.max_output_bytes, params.maxOutputBytes);

  const logPath = resolveLogPath(taskId, params.logsDir);
  appendLog(logPath, `task_received type=${jobType} agent=${payloadAgent} repo=${repo}`, params.logsDir);

  const jobStore = new SqliteStore(dbPath, process.env.CLAWBRAIN_MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations"));
  jobStore.init();

  jobStore.createTask({
    taskId,
    sessionId,
    repo,
    agent: payloadAgent,
    status: "queued",
    requestText,
    logPath,
  });
  jobStore.updateTaskStatus({
    taskId,
    status: "running",
    startedAt: new Date().toISOString(),
  });

  let result: JobExecutionResult;
  try {
    validatePathsWrite(params.policy, logPath);
    validatePathsWrite(params.policy, path.resolve(path.join(params.memoryDir, `${repo}.md`)));
    if (stack) {
      validateStack(params.policy, stack);
    }

    if (jobType === "command") {
      result = processCommandJob({
        taskId,
        repo,
        payloadAgent,
        commandRaw,
        workerAgent: params.workerAgent,
        policy: params.policy,
        store: jobStore,
        logPath,
        logsDir: params.logsDir,
        commandTimeout,
        maxOutputBytes,
      });
    } else {
      validatePathsWrite(params.policy, path.resolve(params.artifactsDir));
      result = processCodexJob({
        taskId,
        repo,
        payloadAgent,
        requestText,
        commandRaw,
        workerAgent: params.workerAgent,
        workerUser: params.workerUser,
        policy: params.policy,
        store: jobStore,
        logPath,
        logsDir: params.logsDir,
        artifactsDir: params.artifactsDir,
        commandTimeout,
        maxOutputBytes,
      });
    }
  } catch (error) {
    if (error instanceof PolicyError) {
      result = policyDenied({
        store: jobStore,
        taskId,
        workerUser: params.workerUser,
        logPath,
        logsDir: params.logsDir,
        reason: error.message,
        commandRaw,
      });
    } else {
      appendLog(logPath, `execution_failed: ${String(error)}`, params.logsDir);
      jobStore.insertAuditEvent({
        taskId,
        actorType: "system",
        actor: params.workerUser,
        action: "execution_failed",
        detail: { error: String(error) },
      });
      result = {
        status: "failed",
        summary: `FAILED: execution_error=${String(error)}`,
        exitCode: null,
      };
    }
  }

  let finalResult = result;
  try {
    const memory = updateMemory({
      repo,
      summaryText: result.summary,
      store: jobStore,
      memoryDir: params.memoryDir,
    });

    jobStore.insertAuditEvent({
      taskId,
      actorType: "agent",
      actor: params.workerAgent,
      action: "memory_updated",
      detail: { memory_path: memory.memoryPath, content_hash: memory.contentHash },
    });
    appendLog(logPath, `memory_updated: ${memory.memoryPath}`, params.logsDir);
  } catch (error) {
    jobStore.insertAuditEvent({
      taskId,
      actorType: "system",
      actor: params.workerUser,
      action: "memory_update_failed",
      detail: { error: String(error) },
    });
    appendLog(logPath, `memory_update_failed: ${String(error)}`, params.logsDir);
    finalResult = {
      status: "failed",
      summary: `FAILED: ${result.summary} memory_error=${String(error)}`,
      exitCode: result.exitCode,
      artifactsDir: result.artifactsDir,
    };
  }

  jobStore.updateTaskStatus({
    taskId,
    status: finalResult.status,
    finishedAt: new Date().toISOString(),
    exitCode: finalResult.exitCode ?? undefined,
    summaryText: finalResult.summary,
    logPath,
    artifactsDir: finalResult.artifactsDir ?? undefined,
  });

  appendLog(
    logPath,
    `task_finished status=${finalResult.status} exit_code=${String(finalResult.exitCode)}`,
    params.logsDir,
  );

  jobStore.close();
  return finalResult;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const logsDir = path.resolve(process.env.CLAWBRAIN_LOGS_DIR ?? DEFAULT_LOGS_DIR);
  const memoryDir = path.resolve(process.env.CLAWBRAIN_MEMORY_DIR ?? DEFAULT_MEMORY_DIR);
  const artifactsDir = path.resolve(process.env.CLAWBRAIN_ARTIFACTS_DIR ?? DEFAULT_ARTIFACTS_DIR);
  const configDir = path.resolve(process.env.CLAWBRAIN_CONFIG_DIR ?? DEFAULT_CONFIG_DIR);
  const policyPath = path.join(configDir, "policy.yaml");

  let policy: PolicyConfig;
  let workerUser: string;
  try {
    const identity = ensureWorkerIdentity(policyPath, args.agent);
    policy = identity.policy;
    workerUser = identity.workerUser;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[FAIL] worker startup validation failed: ${String(error)}`);
    return 1;
  }

  const queue = new RedisQueue({ redisUrl: args.redisUrl, queueName: args.queueName });
  try {
    await queue.ping();
  } catch (error) {
    if (error instanceof QueueError) {
      // eslint-disable-next-line no-console
      console.error(`[FAIL] queue unavailable: ${error.message}`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[FAIL] queue unavailable: ${String(error)}`);
    }
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log(`[INFO] worker ready agent=${args.agent} user=${workerUser} queue=${args.queueName}`);

  let lastHeartbeat = 0;
  const maybeHeartbeat = async (state: string): Promise<void> => {
    const now = Date.now();
    if (now - lastHeartbeat < Math.max(2, args.heartbeatInterval) * 1000) {
      return;
    }
    try {
      await queue.publishHeartbeat({
        agent: args.agent,
        linuxUser: workerUser,
        ttlSeconds: Math.max(15, args.heartbeatTtl),
        extra: { state },
      });
      lastHeartbeat = now;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[WARN] heartbeat publish failed: ${String(error)}`);
    }
  };

  while (true) {
    await maybeHeartbeat("idle");

    let job: Record<string, unknown> | null;
    try {
      job = await queue.dequeue(args.pollTimeout);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[FAIL] dequeue error: ${String(error)}`);
      return 1;
    }

    if (!job) {
      if (args.once) {
        // eslint-disable-next-line no-console
        console.error("[FAIL] --once set but no job available");
        return 1;
      }
      continue;
    }

    const payloadAgent = String(job.agent ?? "").trim();
    if (payloadAgent && payloadAgent !== args.agent) {
      await maybeHeartbeat("requeue");
      try {
        await queue.enqueue(job);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[FAIL] failed to requeue task for agent ${payloadAgent}: ${String(error)}`);
        return 1;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[INFO] requeued task ${String(job.task_id ?? "<unknown>")} for agent=${payloadAgent} (worker agent=${args.agent})`,
      );
      if (args.once) {
        // eslint-disable-next-line no-console
        console.error(`[FAIL] --once worker for ${args.agent} received task for ${payloadAgent}`);
        return 1;
      }
      continue;
    }

    await maybeHeartbeat("running");
    const result = processJob({
      job,
      workerAgent: args.agent,
      workerUser,
      policy,
      store: new SqliteStore(path.resolve(args.dbPath), process.env.CLAWBRAIN_MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations")),
      defaultDbPath: args.dbPath,
      logsDir,
      memoryDir,
      artifactsDir,
      commandTimeout: args.commandTimeout,
      maxOutputBytes: args.maxOutputBytes,
    });
    await maybeHeartbeat("idle");

    if (args.once) {
      return result.status === "succeeded" || result.status === "blocked" ? 0 : 1;
    }

    if (result.status !== "succeeded" && result.status !== "blocked") {
      // eslint-disable-next-line no-console
      console.warn(`[WARN] task failed with status=${result.status}`);
    }
  }
}

if (require.main === module) {
  void main(process.argv).then((code) => process.exit(code));
}
