import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOGS_DIR = "/data/clawbrain/logs";

function isPathInside(basePath: string, targetPath: string, allowEqual: boolean): boolean {
  const relative = path.relative(basePath, targetPath);
  if (!relative) {
    return allowEqual;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function ensureInside(baseDir: string, target: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(target);
  if (!isPathInside(resolvedBase, resolvedTarget, true)) {
    throw new Error(`path escapes log root: ${resolvedTarget}`);
  }
}

export function resolveLogPath(taskId: string, logsDir = DEFAULT_LOGS_DIR): string {
  const task = (taskId ?? "").trim();
  if (!task) {
    throw new Error("task_id must be non-empty");
  }
  if (task.includes("/") || task.includes("\\")) {
    throw new Error("task_id must not contain path separators");
  }

  const root = path.resolve(logsDir);
  fs.mkdirSync(root, { recursive: true });
  const logPath = path.resolve(path.join(root, `${task}.log`));
  ensureInside(root, logPath);
  return logPath;
}

export function appendLog(logPath: string, message: string, logsDir = DEFAULT_LOGS_DIR): void {
  const targetPath = path.resolve(logPath);
  const root = path.resolve(logsDir);
  fs.mkdirSync(root, { recursive: true });
  ensureInside(root, targetPath);

  const line = `[${new Date().toISOString()}] ${message.trimEnd()}\n`;
  fs.appendFileSync(targetPath, line, { encoding: "utf-8" });
}
