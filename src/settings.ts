import path from "node:path";

export interface Settings {
  configDir: string;
  dbPath: string;
  logsDir: string;
  memoryDir: string;
  artifactsDir: string;
  redisUrl: string;
  queueName: string;
  apiTokenFile: string;
  migrationsDir: string;
}

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (cachedSettings) {
    return cachedSettings;
  }

  const cwd = process.cwd();
  cachedSettings = {
    configDir: path.resolve(process.env.CLAWBRAIN_CONFIG_DIR ?? "/data/clawbrain/config"),
    dbPath: path.resolve(process.env.CLAWBRAIN_DB_PATH ?? "/data/clawbrain/db/clawbrain.sqlite3"),
    logsDir: path.resolve(process.env.CLAWBRAIN_LOGS_DIR ?? "/data/clawbrain/logs"),
    memoryDir: path.resolve(process.env.CLAWBRAIN_MEMORY_DIR ?? "/data/clawbrain/memory"),
    artifactsDir: path.resolve(
      process.env.CLAWBRAIN_ARTIFACTS_DIR ?? "/data/clawbrain/artifacts",
    ),
    redisUrl: process.env.CLAWBRAIN_REDIS_URL ?? "redis://127.0.0.1:6379/0",
    queueName: process.env.CLAWBRAIN_QUEUE_NAME ?? "clawbrain:tasks",
    apiTokenFile: path.resolve(
      process.env.CLAWBRAIN_API_TOKEN_FILE ?? "/data/clawbrain/secrets/api_token",
    ),
    migrationsDir: path.resolve(process.env.CLAWBRAIN_MIGRATIONS_DIR ?? path.join(cwd, "migrations")),
  };

  return cachedSettings;
}
