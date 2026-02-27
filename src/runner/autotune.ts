import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { QueueError, PolicyError } from "../errors";
import { loadPolicy } from "../policy";
import { RedisQueue } from "../queue";

const DEFAULT_CONFIG_DIR = "/data/clawbrain/config";
const DEFAULT_LOGS_DIR = "/data/clawbrain/logs";
const DEFAULT_ARTIFACTS_DIR = "/data/clawbrain/artifacts";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";
const DEFAULT_QUEUE_NAME = "clawbrain:tasks";
const DEFAULT_STATUS_REDIS_KEY = "clawbrain:agent_status:latest";

interface AutoTuneArgs {
  configDir: string;
  logsDir: string;
  artifactsDir: string;
  redisUrl: string;
  queueName: string;
  statusRedisKey: string;
  intervalSeconds: number;
  maxLogFiles: number;
  once: boolean;
}

function parseArgs(argv: string[]): AutoTuneArgs {
  const program = new Command();
  program
    .option("--config-dir <dir>", "Config dir", process.env.CLAWBRAIN_CONFIG_DIR ?? DEFAULT_CONFIG_DIR)
    .option("--logs-dir <dir>", "Logs dir", process.env.CLAWBRAIN_LOGS_DIR ?? DEFAULT_LOGS_DIR)
    .option("--artifacts-dir <dir>", "Artifacts dir", process.env.CLAWBRAIN_ARTIFACTS_DIR ?? DEFAULT_ARTIFACTS_DIR)
    .option("--redis-url <url>", "Redis URL", process.env.CLAWBRAIN_REDIS_URL ?? DEFAULT_REDIS_URL)
    .option("--queue-name <name>", "Queue name", process.env.CLAWBRAIN_QUEUE_NAME ?? DEFAULT_QUEUE_NAME)
    .option(
      "--status-redis-key <key>",
      "Maintainer status key",
      process.env.CLAWBRAIN_AGENT_STATUS_REDIS_KEY ?? DEFAULT_STATUS_REDIS_KEY,
    )
    .option(
      "--interval-seconds <sec>",
      "Run interval",
      process.env.CLAWBRAIN_AUTOTUNE_INTERVAL_SEC ?? "180",
    )
    .option(
      "--max-log-files <n>",
      "Max recent log files",
      process.env.CLAWBRAIN_AUTOTUNE_MAX_LOG_FILES ?? "40",
    )
    .option("--once", "Run one cycle", false);

  program.parse(argv);
  const opts = program.opts<Record<string, string | boolean>>();
  return {
    configDir: String(opts.configDir),
    logsDir: String(opts.logsDir),
    artifactsDir: String(opts.artifactsDir),
    redisUrl: String(opts.redisUrl),
    queueName: String(opts.queueName),
    statusRedisKey: String(opts.statusRedisKey),
    intervalSeconds: Number(opts.intervalSeconds),
    maxLogFiles: Number(opts.maxLogFiles),
    once: Boolean(opts.once),
  };
}

function summarizeRecentLogs(logsDir: string, maxFiles: number): Record<string, unknown> {
  const root = path.resolve(logsDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      log_files_count: 0,
      total_log_size_bytes: 0,
      newest_logs: [],
    };
  }

  const entries = fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".log"))
    .map((name) => {
      const absolute = path.join(root, name);
      const stat = fs.statSync(absolute);
      return { name, absolute, stat };
    })
    .filter((entry) => entry.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const newest = entries.slice(0, Math.max(1, Math.floor(maxFiles)));
  let totalSize = 0;
  const newestLogs = newest.slice(0, 10).map((entry) => {
    totalSize += entry.stat.size;
    return {
      name: entry.name,
      size_bytes: entry.stat.size,
      mtime: new Date(entry.stat.mtimeMs).toISOString(),
    };
  });

  return {
    log_files_count: entries.length,
    total_log_size_bytes: totalSize,
    newest_logs: newestLogs,
  };
}

async function loadStatusSnapshot(queue: RedisQueue, statusRedisKey: string): Promise<Record<string, unknown>> {
  try {
    const raw = await queue.getRaw(statusRedisKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function containsAny(text: string, keywords: string[]): boolean {
  const low = text.toLowerCase();
  return keywords.some((keyword) => low.includes(keyword));
}

function buildRecommendations(params: {
  policy: ReturnType<typeof loadPolicy> | null;
  queueDepth: number;
  statusSnapshot: Record<string, unknown>;
  logsSummary: Record<string, unknown>;
}): string[] {
  const recommendations: string[] = [];
  const missingAgents = Array.isArray(params.statusSnapshot.missing_agents)
    ? (params.statusSnapshot.missing_agents as unknown[]).map((value) => String(value))
    : [];

  if (params.queueDepth >= 5) {
    recommendations.push(
      "Queue depth >= 5: activar profile reinforce para escalar runner-coder-r2 y runner-builder-r2.",
    );
  } else if (params.queueDepth > 0) {
    recommendations.push("Hay tareas en cola: monitorear tiempos y mantener AutoTuneAgent activo.");
  } else {
    recommendations.push("Cola en cero: estado estable.");
  }

  if (missingAgents.length > 0) {
    recommendations.push(
      `Agentes faltantes reportados por maintainer: ${missingAgents.join(", ")}.`,
    );
  } else {
    recommendations.push("Maintainer reporta agentes requeridos en linea.");
  }

  if (!params.policy) {
    recommendations.push("No se pudo cargar policy activa, validar /data/clawbrain/config/policy.yaml.");
  } else {
    if ((params.policy.repos_allowed ?? []).length === 0) {
      recommendations.push(
        "Policy con repos_allowed vacio (DENY ALL): no se ejecutaran tareas de repo hasta definir allowlist.",
      );
    }
    if ((params.policy.stacks_allowed ?? []).length === 0) {
      recommendations.push("Policy con stacks_allowed vacio (DENY ALL deploy stacks).");
    }
  }

  const logFilesCount = Number(params.logsSummary.log_files_count ?? 0);
  const totalLogSize = Number(params.logsSummary.total_log_size_bytes ?? 0);
  if (logFilesCount === 0) {
    recommendations.push("No hay logs de tareas aun: ejecuta un task de smoke test para poblar auditoria.");
  } else if (totalLogSize > 30 * 1024 * 1024) {
    recommendations.push("Logs recientes >30MB: planificar rotacion/retencion de logs.");
  }

  return recommendations;
}

function markdownReport(report: Record<string, unknown>): string {
  const metrics = (report.metrics as Record<string, unknown>) ?? {};
  const status = (report.status as Record<string, unknown>) ?? {};
  const recs = Array.isArray(report.recommendations)
    ? (report.recommendations as unknown[]).map((item) => String(item))
    : [];

  const lines: string[] = [
    "# AutoTuneAgent Report",
    "",
    `- generated_at: ${String(report.generated_at ?? "")}`,
    `- queue_depth: ${String(metrics.queue_depth ?? "")}`,
    `- agents_alive: ${String(status.agents_alive ?? "")}`,
    `- agents_missing: ${String(status.agents_missing ?? "")}`,
    `- log_files_count: ${String(metrics.log_files_count ?? "")}`,
    "",
    "## Recommendations",
  ];

  for (const item of recs) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}

function writeReport(artifactsDir: string, report: Record<string, unknown>): { latestJson: string; latestMd: string } {
  const outDir = path.resolve(path.join(artifactsDir, "auto_improve"));
  fs.mkdirSync(outDir, { recursive: true });

  const now = new Date();
  const tsToken = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  const reportJson = path.join(outDir, `report_${tsToken}.json`);
  const reportMd = path.join(outDir, `report_${tsToken}.md`);
  const latestJson = path.join(outDir, "latest_report.json");
  const latestMd = path.join(outDir, "latest_report.md");

  const reportJsonText = `${JSON.stringify(report, null, 2)}\n`;
  const reportMdText = `${markdownReport(report)}\n`;

  fs.writeFileSync(reportJson, reportJsonText, { encoding: "utf-8" });
  fs.writeFileSync(reportMd, reportMdText, { encoding: "utf-8" });
  fs.writeFileSync(latestJson, reportJsonText, { encoding: "utf-8" });
  fs.writeFileSync(latestMd, reportMdText, { encoding: "utf-8" });

  return { latestJson, latestMd };
}

async function runCycle(args: AutoTuneArgs): Promise<number> {
  const queue = new RedisQueue({ redisUrl: args.redisUrl, queueName: args.queueName });
  await queue.ping();

  let policy: ReturnType<typeof loadPolicy> | null = null;
  try {
    policy = loadPolicy(path.join(path.resolve(args.configDir), "policy.yaml"));
  } catch (error) {
    if (!(error instanceof PolicyError)) {
      // eslint-disable-next-line no-console
      console.warn(`[autotune][WARN] failed to load policy: ${String(error)}`);
    }
  }

  const queueDepth = await queue.length();
  const statusSnapshot = await loadStatusSnapshot(queue, args.statusRedisKey);
  const logsSummary = summarizeRecentLogs(args.logsDir, args.maxLogFiles);
  const recommendations = buildRecommendations({
    policy,
    queueDepth,
    statusSnapshot,
    logsSummary,
  });

  const agents = Array.isArray(statusSnapshot.agents)
    ? (statusSnapshot.agents as unknown[]).filter(
        (value) => value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  let agentsAlive = 0;
  let agentsMissing = 0;
  for (const item of agents as Array<Record<string, unknown>>) {
    if (Boolean(item.alive)) {
      agentsAlive += 1;
    } else {
      agentsMissing += 1;
    }
  }

  const report: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    agent: "AutoTuneAgent",
    metrics: {
      queue_depth: queueDepth,
      log_files_count: Number(logsSummary.log_files_count ?? 0),
      total_log_size_bytes: Number(logsSummary.total_log_size_bytes ?? 0),
      newest_logs: logsSummary.newest_logs ?? [],
    },
    status: {
      agents_alive: agentsAlive,
      agents_missing: agentsMissing,
      maintainer_snapshot_ts: statusSnapshot.ts,
    },
    recommendations,
  };

  const reportPaths = writeReport(args.artifactsDir, report);
  await queue.publishHeartbeat({
    agent: "AutoTuneAgent",
    linuxUser: process.env.CLAWBRAIN_AUTOTUNE_LINUX_USER ?? "codex",
    ttlSeconds: Math.max(20, Math.floor(args.intervalSeconds) * 2),
    extra: {
      state: "idle",
      report_json: reportPaths.latestJson,
      report_md: reportPaths.latestMd,
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `[autotune] generated_at=${String(report.generated_at)} queue_depth=${queueDepth} report=${reportPaths.latestJson}`,
  );

  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const interval = Math.max(30, Math.floor(args.intervalSeconds));

  while (true) {
    let code = 0;
    try {
      code = await runCycle(args);
    } catch (error) {
      if (error instanceof QueueError) {
        // eslint-disable-next-line no-console
        console.error(`[autotune][FAIL] redis error: ${error.message}`);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[autotune][FAIL] unexpected: ${String(error)}`);
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
