import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SqliteStore } from "../db";

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

function validateRepoName(repo: string): string {
  const name = (repo ?? "").trim();
  if (!name) {
    throw new Error("repo must be non-empty");
  }
  if (!REPO_NAME_RE.test(name)) {
    throw new Error(`invalid repo name: ${repo}`);
  }
  return name;
}

function resolveMemoryPath(repo: string, memoryDir: string): string {
  const root = path.resolve(memoryDir);
  fs.mkdirSync(root, { recursive: true });
  const target = path.resolve(path.join(root, `${repo}.md`));

  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`memory path escapes root: ${target}`);
  }

  return target;
}

export function updateMemory(params: {
  repo: string;
  summaryText: string;
  store: SqliteStore;
  memoryDir: string;
}): { memoryPath: string; contentHash: string } {
  const repoName = validateRepoName(params.repo);
  const memoryPath = resolveMemoryPath(repoName, params.memoryDir);

  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, "", { encoding: "utf-8" });
  }

  try {
    fs.chmodSync(memoryPath, 0o666);
  } catch {
    // Best effort for shared memory file permissions across users.
  }

  const ts = new Date().toISOString();
  const line = `- ${ts} ${(params.summaryText ?? "").trim()}\n`;
  fs.appendFileSync(memoryPath, line, { encoding: "utf-8" });

  const content = fs.readFileSync(memoryPath);
  const contentHash = createHash("sha256").update(content).digest("hex");

  params.store.upsertRepoMemoryIndex({
    repo: repoName,
    memoryPath,
    updatedAt: ts,
    contentHash,
  });

  return { memoryPath, contentHash };
}
