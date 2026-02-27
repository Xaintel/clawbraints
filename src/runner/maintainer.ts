import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { QueueError } from "../errors";
import { loadPolicy } from "../policy";
import { RedisQueue } from "../queue";

const DEFAULT_CONFIG_DIR = "/data/clawbrain/config";
const DEFAULT_LOGS_DIR = "/data/clawbrain/logs";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";
const DEFAULT_QUEUE_NAME = "clawbrain:tasks";
const DEFAULT_STATUS_REDIS_KEY = "clawbrain:agent_status:latest";

interface MaintainerArgs {
  configDir: string;
  logsDir: string;
  redisUrl: string;
  queueName: string;
  heartbeatStaleSeconds: number;
  intervalSeconds: number;
  statusFile: string;
  statusRedisKey: string;
  requiredAgents: string;
  once: boolean;
  failOnMissing: boolean;
}

function parseArgs(argv: string[]): MaintainerArgs {
  const program = new Command();
  program
    .option("--config-dir <dir>", "Config dir", process.env.CLAWBRAIN_CONFIG_DIR ?? DEFAULT_CONFIG_DIR)
    .option("--logs-dir <dir>", "Logs dir", process.env.CLAWBRAIN_LOGS_DIR ?? DEFAULT_LOGS_DIR)
    .option("--redis-url <url>", "Redis URL", process.env.CLAWBRAIN_REDIS_URL ?? DEFAULT_REDIS_URL)
    .option("--queue-name <name>", "Queue name", process.env.CLAWBRAIN_QUEUE_NAME ?? DEFAULT_QUEUE_NAME)
    .option(
      "--heartbeat-stale-seconds <sec>",
      "Heartbeat stale threshold",
      process.env.CLAWBRAIN_HEARTBEAT_STALE_SEC ?? "90",
    )
    .option(
      "--interval-seconds <sec>",
      "Run interval",
      process.env.CLAWBRAIN_MAINTAINER_INTERVAL_SEC ?? "15",
    )
    .option(
      "--status-file <path>",
      "Status output file",
      process.env.CLAWBRAIN_AGENT_STATUS_FILE ?? path.join(DEFAULT_LOGS_DIR, "agent_maintainer_status.json"),
    )
    .option(
      "--status-redis-key <key>",
      "Status key",
      process.env.CLAWBRAIN_AGENT_STATUS_REDIS_KEY ?? DEFAULT_STATUS_REDIS_KEY,
    )
    .option(
      "--required-agents <csv>",
      "Comma-separated required agents",
      process.env.CLAWBRAIN_MAINTAINER_REQUIRED_AGENTS ?? "",
    )
    .option("--once", "Run one cycle", false)
    .option("--fail-on-missing", "Exit non-zero if missing agents", false);

  program.parse(argv);
  const opts = program.opts<Record<string, string | boolean>>();
  return {
    configDir: String(opts.configDir),
    logsDir: String(opts.logsDir),
    redisUrl: String(opts.redisUrl),
    queueName: String(opts.queueName),
    heartbeatStaleSeconds: Number(opts.heartbeatStaleSeconds),
    intervalSeconds: Number(opts.intervalSeconds),
    statusFile: String(opts.statusFile),
    statusRedisKey: String(opts.statusRedisKey),
    requiredAgents: String(opts.requiredAgents),
    once: Boolean(opts.once),
    failOnMissing: Boolean(opts.failOnMissing),
  };
}

function parseIsoTs(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }

  const fixed = text.endsWith("Z") ? `${text.slice(0, -1)}+00:00` : text;
  const date = new Date(fixed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function buildStatusSnapshot(params: {
  queueName: string;
  queueDepth: number;
  heartbeats: Record<string, unknown>[];
  expectedAgents: Set<string>;
  staleSeconds: number;
}): Record<string, unknown> {
  const now = Date.now();
  const staleAfterMs = Math.max(10, Math.floor(params.staleSeconds)) * 1000;

  const byAgent: Record<string, Record<string, unknown>[]> = {};
  for (const item of params.heartbeats) {
    const agentName = String(item.agent ?? "").trim();
    if (!agentName) {
      continue;
    }
    byAgent[agentName] = byAgent[agentName] ?? [];
    byAgent[agentName].push(item);
  }

  const agents: Record<string, unknown>[] = [];
  const missingAgents: string[] = [];

  for (const agent of Array.from(params.expectedAgents).sort((a, b) => a.localeCompare(b))) {
    const instances = byAgent[agent] ?? [];
    let newestTsMs: number | null = null;

    const mappedInstances = instances.map((instance) => {
      const ts = parseIsoTs(instance.ts);
      const ageS = ts ? Math.floor((now - ts.getTime()) / 1000) : null;
      const stale = ts ? (ageS ?? Number.POSITIVE_INFINITY) > staleAfterMs / 1000 : true;
      if (ts && (newestTsMs === null || ts.getTime() > newestTsMs)) {
        newestTsMs = ts.getTime();
      }
      return {
        linux_user: instance.linux_user,
        host: instance.host,
        pid: instance.pid,
        state: instance.state,
        queue: instance.queue,
        ts: instance.ts,
        age_s: ageS,
        stale,
      };
    });

    const active = mappedInstances.filter((instance) => !Boolean(instance.stale));
    const alive = active.length > 0;
    if (!alive) {
      missingAgents.push(agent);
    }

    agents.push({
      name: agent,
      alive,
      instances_total: mappedInstances.length,
      instances_active: active.length,
      last_seen_ts: newestTsMs !== null ? new Date(newestTsMs).toISOString() : null,
      instances: mappedInstances,
    });
  }

  return {
    ts: new Date().toISOString(),
    queue_name: params.queueName,
    queue_depth: params.queueDepth,
    heartbeat_stale_seconds: Math.max(10, Math.floor(params.staleSeconds)),
    expected_agents: Array.from(params.expectedAgents).sort((a, b) => a.localeCompare(b)),
    missing_agents: missingAgents,
    agents,
  };
}

function writeStatus(statusFile: string, payload: Record<string, unknown>): void {
  const target = path.resolve(statusFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8" });
  fs.renameSync(tmp, target);
}

async function runOnce(args: MaintainerArgs): Promise<number> {
  const configDir = path.resolve(args.configDir);
  const policyPath = path.join(configDir, "policy.yaml");
  const policy = loadPolicy(policyPath);

  const configuredRequired = args.requiredAgents
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const expectedAgents =
    configuredRequired.length > 0
      ? new Set(configuredRequired)
      : new Set(Object.keys(policy.agents));

  const queue = new RedisQueue({ redisUrl: args.redisUrl, queueName: args.queueName });
  await queue.ping();
  const queueDepth = await queue.length();
  const heartbeats = await queue.listHeartbeats();

  const snapshot = buildStatusSnapshot({
    queueName: args.queueName,
    queueDepth,
    heartbeats,
    expectedAgents,
    staleSeconds: args.heartbeatStaleSeconds,
  });

  await queue.publishHeartbeat({
    agent: "AgentMaintainer",
    linuxUser: process.env.CLAWBRAIN_MAINTAINER_LINUX_USER ?? "codex",
    ttlSeconds: Math.max(20, Math.floor(args.intervalSeconds) * 2),
    extra: { state: "idle", queue_depth: queueDepth },
  });

  await queue.setRaw(args.statusRedisKey, JSON.stringify(snapshot));

  try {
    writeStatus(args.statusFile, snapshot);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[maintainer][WARN] status file write skipped: ${String(error)}`);
  }

  const missing = Array.isArray(snapshot.missing_agents) ? (snapshot.missing_agents as unknown[]) : [];
  // eslint-disable-next-line no-console
  console.log(
    `[maintainer] ts=${String(snapshot.ts)} queue_depth=${queueDepth} missing_agents=${missing.length} status_file=${path.resolve(args.statusFile)} status_redis_key=${args.statusRedisKey}`,
  );

  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[maintainer] missing=${missing.join(",")}`);
    if (args.failOnMissing) {
      return 1;
    }
  }

  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const interval = Math.max(5, Math.floor(args.intervalSeconds));

  while (true) {
    let code = 0;
    try {
      code = await runOnce(args);
    } catch (error) {
      if (error instanceof QueueError) {
        // eslint-disable-next-line no-console
        console.error(`[maintainer][FAIL] ${error.message}`);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[maintainer][FAIL] ${String(error)}`);
      }
      code = 1;
    }

    if (args.once) {
      return code;
    }

    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

if (require.main === module) {
  void main(process.argv).then((code) => process.exit(code));
}
