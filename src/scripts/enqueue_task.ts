import path from "node:path";
import { randomUUID } from "node:crypto";

import { Command } from "commander";

import { SqliteStore } from "../db";
import { QueueError } from "../errors";
import { resolveLogPath } from "../logging";
import { RedisQueue } from "../queue";

const DEFAULT_DB_PATH = "/data/clawbrain/db/clawbrain.sqlite3";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";
const DEFAULT_QUEUE_NAME = "clawbrain:tasks";
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
const ALLOWED_JOB_TYPES = ["command", "codex"] as const;

interface Args {
  type: (typeof ALLOWED_JOB_TYPES)[number];
  repo: string;
  agent: (typeof ALLOWED_AGENTS)[number];
  command: string;
  requestText: string;
  sessionId: string | null;
  stack: string | null;
  dbPath: string;
  redisUrl: string;
  queueName: string;
}

function parseArgs(argv: string[]): Args {
  const program = new Command();
  program
    .option("--type <type>", "command|codex", "command")
    .requiredOption("--repo <repo>")
    .requiredOption("--agent <agent>")
    .option("--command <command>")
    .requiredOption("--request-text <text>")
    .option("--session-id <id>")
    .option("--stack <name>")
    .option("--db-path <path>", "DB path", process.env.CLAWBRAIN_DB_PATH ?? DEFAULT_DB_PATH)
    .option("--redis-url <url>", "Redis URL", process.env.CLAWBRAIN_REDIS_URL ?? DEFAULT_REDIS_URL)
    .option("--queue-name <name>", "Queue name", process.env.CLAWBRAIN_QUEUE_NAME ?? DEFAULT_QUEUE_NAME);

  program.parse(argv);
  const opts = program.opts<Record<string, string | undefined>>();

  const type = String(opts.type ?? "command").trim() as (typeof ALLOWED_JOB_TYPES)[number];
  const agent = String(opts.agent ?? "").trim() as (typeof ALLOWED_AGENTS)[number];

  if (!ALLOWED_JOB_TYPES.includes(type)) {
    throw new Error(`[FAIL] invalid --type '${type}'`);
  }
  if (!ALLOWED_AGENTS.includes(agent)) {
    throw new Error(`[FAIL] invalid --agent '${agent}'`);
  }

  return {
    type,
    repo: String(opts.repo ?? "").trim(),
    agent,
    command: String(opts.command ?? "").trim(),
    requestText: String(opts.requestText ?? "").trim(),
    sessionId: opts.sessionId ? String(opts.sessionId).trim() : null,
    stack: opts.stack ? String(opts.stack).trim() : null,
    dbPath: String(opts.dbPath ?? DEFAULT_DB_PATH),
    redisUrl: String(opts.redisUrl ?? DEFAULT_REDIS_URL),
    queueName: String(opts.queueName ?? DEFAULT_QUEUE_NAME),
  };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const taskId = randomUUID();
  const createdAt = new Date().toISOString();
  const dbPath = path.resolve(args.dbPath);

  let command = args.command;
  if (args.type === "command" && !command) {
    // eslint-disable-next-line no-console
    console.error("[FAIL] --command is required when --type=command");
    return 1;
  }

  if (args.type === "codex" && !command) {
    command = `codex exec --skip-git-repo-check --sandbox workspace-write -C /srv/projects/${args.repo} -`;
  }

  const logsDir = path.resolve(process.env.CLAWBRAIN_LOGS_DIR ?? "/data/clawbrain/logs");
  const logPath = resolveLogPath(taskId, logsDir);

  const store = new SqliteStore(dbPath, process.env.CLAWBRAIN_MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations"));
  store.init();
  store.createTask({
    taskId,
    sessionId: args.sessionId,
    repo: args.repo,
    agent: args.agent,
    status: "queued",
    requestText: args.requestText,
    logPath,
    createdAt,
  });
  store.close();

  const queue = new RedisQueue({ redisUrl: args.redisUrl, queueName: args.queueName });
  try {
    await queue.ping();
    await queue.enqueue({
      task_id: taskId,
      session_id: args.sessionId,
      type: args.type,
      repo: args.repo,
      agent: args.agent,
      command,
      request_text: args.requestText,
      stack: args.stack,
      db_path: dbPath,
      created_at: createdAt,
    });
  } catch (error) {
    if (error instanceof QueueError) {
      // eslint-disable-next-line no-console
      console.error(`[FAIL] queue error: ${error.message}`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[FAIL] queue error: ${String(error)}`);
    }
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      task_id: taskId,
      type: args.type,
      queue_name: args.queueName,
      db_path: dbPath,
      log_path: logPath,
    }),
  );
  return 0;
}

if (require.main === module) {
  void main(process.argv).then((code) => process.exit(code));
}
