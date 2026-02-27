import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENV_CONFIG_PATH = "CLAWBRAIN_IDE_CONFIG";
export const ENV_SERVER_URL = "CLAWBRAIN_IDE_SERVER_URL";
export const ENV_TOKEN = "CLAWBRAIN_IDE_TOKEN";
export const ENV_TIMEOUT_SEC = "CLAWBRAIN_IDE_TIMEOUT_SEC";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8088";
export const DEFAULT_TIMEOUT_SEC = 30;
export const DEFAULT_CONFIG_PATH = path.resolve(path.join(os.homedir(), ".config", "clawbrain-ide", "config.json"));

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface IDEClientConfig {
  serverUrl: string;
  token: string;
  timeoutSec: number;
  configPath: string;
}

function resolveConfigPath(): string {
  const raw = String(process.env[ENV_CONFIG_PATH] ?? "").trim();
  return raw ? path.resolve(raw) : DEFAULT_CONFIG_PATH;
}

function normalizeServerUrl(serverUrl: string): string {
  const value = String(serverUrl ?? "").trim();
  if (!value) {
    throw new ConfigError("server_url cannot be empty");
  }
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    throw new ConfigError("server_url must start with http:// or https://");
  }
  return value.replace(/\/+$/, "");
}

function readConfigFile(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config file must contain a JSON object: ${configPath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`invalid JSON config at ${configPath}: ${String(error)}`);
  }
}

function parseTimeout(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_TIMEOUT_SEC;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`invalid timeout value: ${String(raw)}`);
  }
  return Math.floor(value);
}

export function loadConfig(options?: { requireToken?: boolean }): IDEClientConfig {
  const requireToken = options?.requireToken ?? true;
  const configPath = resolveConfigPath();
  const fileData = readConfigFile(configPath);

  const rawServerUrl =
    String(process.env[ENV_SERVER_URL] ?? "").trim() ||
    String(fileData.server_url ?? DEFAULT_SERVER_URL);
  const rawToken =
    String(process.env[ENV_TOKEN] ?? "").trim() || String(fileData.token ?? "").trim();
  const rawTimeout =
    String(process.env[ENV_TIMEOUT_SEC] ?? "").trim() ||
    (fileData.timeout_sec ?? DEFAULT_TIMEOUT_SEC);

  const serverUrl = normalizeServerUrl(rawServerUrl);
  const timeoutSec = parseTimeout(rawTimeout);

  if (requireToken && !rawToken) {
    throw new ConfigError(
      "missing token. set CLAWBRAIN_IDE_TOKEN or run 'clawbrain-ide config-set --token ...'",
    );
  }

  return {
    serverUrl,
    token: rawToken,
    timeoutSec,
    configPath,
  };
}

export function saveConfig(options: {
  serverUrl?: string;
  token?: string;
  timeoutSec?: number;
}): string {
  const configPath = resolveConfigPath();
  const data = readConfigFile(configPath);

  if (options.serverUrl !== undefined) {
    data.server_url = normalizeServerUrl(options.serverUrl);
  }
  if (options.token !== undefined) {
    const token = String(options.token).trim();
    if (!token) {
      throw new ConfigError("token cannot be empty");
    }
    data.token = token;
  }
  if (options.timeoutSec !== undefined) {
    data.timeout_sec = parseTimeout(options.timeoutSec);
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8" });
  fs.chmodSync(configPath, 0o600);
  return configPath;
}
