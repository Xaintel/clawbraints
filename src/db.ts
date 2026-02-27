import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const TASK_STATUS_VALUES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "blocked",
]);
const ACTOR_TYPE_VALUES = new Set(["agent", "user", "system"]);

export interface TaskRow {
  id: string;
  session_id: string | null;
  repo: string;
  agent: string;
  status: string;
  request_text: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  log_path: string;
  artifacts_dir: string | null;
  summary_text: string | null;
}

function utcNowIso(): string {
  return new Date().toISOString();
}

function parseMigrationVersion(filename: string): number {
  const match = filename.match(/^(\d+)_.*\.sql$/);
  if (!match) {
    return -1;
  }
  return Number(match[1]);
}

function validateStatus(status: string): void {
  if (!TASK_STATUS_VALUES.has(status)) {
    throw new Error(`invalid status: ${status}`);
  }
}

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(
    private readonly dbPath: string,
    private readonly migrationsDir: string,
  ) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(path.resolve(dbPath));
    this.db.pragma("foreign_keys = ON");
  }

  init(): void {
    this.runMigrations();
  }

  close(): void {
    this.db.close();
  }

  private runMigrations(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );

    if (!fs.existsSync(this.migrationsDir) || !fs.statSync(this.migrationsDir).isDirectory()) {
      throw new Error(`migrations dir not found: ${this.migrationsDir}`);
    }

    const files = fs
      .readdirSync(this.migrationsDir)
      .filter((filename) => filename.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    const existsStmt = this.db.prepare("SELECT 1 FROM migrations WHERE version = ?");
    const insertStmt = this.db.prepare("INSERT INTO migrations(version, applied_at) VALUES(?, ?)");

    for (const filename of files) {
      const version = parseMigrationVersion(filename);
      if (version < 0) {
        continue;
      }

      const alreadyApplied = existsStmt.get(version);
      if (alreadyApplied) {
        continue;
      }

      const sql = fs.readFileSync(path.join(this.migrationsDir, filename), "utf-8");
      this.db.exec(sql);
      insertStmt.run(version, utcNowIso());
    }
  }

  createTask(params: {
    taskId: string;
    sessionId: string | null;
    repo: string;
    agent: string;
    status: string;
    requestText: string;
    logPath: string;
    artifactsDir?: string | null;
    createdAt?: string;
  }): void {
    validateStatus(params.status);
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO tasks (
          id, session_id, repo, agent, status, request_text, created_at, log_path, artifacts_dir
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        params.taskId,
        params.sessionId,
        params.repo,
        params.agent,
        params.status,
        params.requestText,
        params.createdAt ?? utcNowIso(),
        params.logPath,
        params.artifactsDir ?? null,
      );
  }

  getTask(taskId: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    return (row as TaskRow | undefined) ?? null;
  }

  updateTaskStatus(params: {
    taskId: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number;
    summaryText?: string;
    logPath?: string;
    artifactsDir?: string;
  }): void {
    validateStatus(params.status);

    const fields: string[] = ["status = ?"];
    const values: unknown[] = [params.status];

    if (params.startedAt !== undefined) {
      fields.push("started_at = ?");
      values.push(params.startedAt);
    }
    if (params.finishedAt !== undefined) {
      fields.push("finished_at = ?");
      values.push(params.finishedAt);
    }
    if (params.exitCode !== undefined) {
      fields.push("exit_code = ?");
      values.push(params.exitCode);
    }
    if (params.summaryText !== undefined) {
      fields.push("summary_text = ?");
      values.push(params.summaryText);
    }
    if (params.logPath !== undefined) {
      fields.push("log_path = ?");
      values.push(params.logPath);
    }
    if (params.artifactsDir !== undefined) {
      fields.push("artifacts_dir = ?");
      values.push(params.artifactsDir);
    }

    values.push(params.taskId);
    const sql = `UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }

  insertAuditEvent(params: {
    taskId: string;
    actorType: string;
    actor: string;
    action: string;
    detail: Record<string, unknown> | string;
    ts?: string;
  }): void {
    if (!ACTOR_TYPE_VALUES.has(params.actorType)) {
      throw new Error(`invalid actor_type: ${params.actorType}`);
    }

    const detailJson =
      typeof params.detail === "string" ? params.detail : JSON.stringify(params.detail);

    this.db
      .prepare(
        `
        INSERT INTO audit_events (task_id, ts, actor_type, actor, action, detail_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        params.taskId,
        params.ts ?? utcNowIso(),
        params.actorType,
        params.actor,
        params.action,
        detailJson,
      );
  }

  upsertRepoMemoryIndex(params: {
    repo: string;
    memoryPath: string;
    updatedAt?: string;
    contentHash?: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO repo_memory_index (repo, memory_path, updated_at, content_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(repo) DO UPDATE SET
          memory_path = excluded.memory_path,
          updated_at = excluded.updated_at,
          content_hash = excluded.content_hash
      `,
      )
      .run(
        params.repo,
        params.memoryPath,
        params.updatedAt ?? utcNowIso(),
        params.contentHash ?? null,
      );
  }
}
