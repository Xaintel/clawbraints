import fs from "node:fs";
import path from "node:path";

import type { Settings } from "./settings";
import { loadPolicy, type PolicyConfig } from "./policy";

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isPathInside(basePath: string, targetPath: string, allowEqual: boolean): boolean {
  const relative = path.relative(basePath, targetPath);
  if (!relative) {
    return allowEqual;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function ensurePathUnder(baseDir: string, targetPath: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (!isPathInside(base, target, true)) {
    throw new Error(`path escapes base directory: ${target}`);
  }
  return target;
}

export function validateRepoName(repo: string): string {
  const repoName = (repo ?? "").trim();
  if (!repoName) {
    throw new Error("repo must be non-empty");
  }
  if (!REPO_NAME_RE.test(repoName)) {
    throw new Error(`invalid repo name: ${repo}`);
  }
  return repoName;
}

export function getMemoryPath(settings: Settings, repo: string): string {
  const repoName = validateRepoName(repo);
  fs.mkdirSync(settings.memoryDir, { recursive: true });
  return ensurePathUnder(settings.memoryDir, path.join(settings.memoryDir, `${repoName}.md`));
}

export function readPolicyOrError(settings: Settings): PolicyConfig {
  try {
    return loadPolicy(path.join(settings.configDir, "policy.yaml"));
  } catch (error) {
    throw new Error(`active policy is invalid: ${String(error)}`);
  }
}
