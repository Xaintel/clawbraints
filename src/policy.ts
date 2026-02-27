import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";
import { parseArgsStringToArgv } from "string-argv";
import { z } from "zod";

import { PolicyError } from "./errors";

const pathsConfigSchema = z.object({
  projects_root: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("/"), "path must be absolute"),
  data_root: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("/"), "path must be absolute"),
  allowed_write_roots: z
    .array(
      z
        .string()
        .min(1)
        .refine((value) => value.startsWith("/"), "allowed_write_roots entries must be absolute paths"),
    )
    .default([]),
});

const agentConfigSchema = z.object({
  linux_user: z.string().min(1),
  allow_sudo: z.boolean().default(false),
  commands_whitelist: z.array(z.string().min(1)).default([]),
  sudo_commands_allowed: z.array(z.string().min(1)).default([]),
});

const policyConfigSchema = z.object({
  version: z.number().int(),
  paths: pathsConfigSchema,
  repos_allowed: z.array(z.string()).default([]),
  agents: z.record(agentConfigSchema),
  stacks_allowed: z.array(z.string()).default([]),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export function loadPolicy(policyPath: string): PolicyConfig {
  if (!fs.existsSync(policyPath)) {
    throw new PolicyError(`policy file not found: ${policyPath}`);
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = yaml.load(fs.readFileSync(policyPath, "utf-8"));
  } catch (error) {
    throw new PolicyError(`invalid YAML policy (${policyPath}): ${String(error)}`);
  }

  const parsed = policyConfigSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    throw new PolicyError(`invalid policy schema (${policyPath}): ${parsed.error.message}`);
  }

  if (Object.keys(parsed.data.agents).length === 0) {
    throw new PolicyError("policy.agents cannot be empty");
  }

  return parsed.data;
}

function normalizeNameList(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}

export function normalizeCommand(command: string): { normalized: string; tokens: string[] } {
  if (!command || !command.trim()) {
    throw new PolicyError("command must be a non-empty string");
  }

  let tokens: string[];
  try {
    tokens = parseArgsStringToArgv(command);
  } catch (error) {
    throw new PolicyError(`invalid command syntax: ${String(error)}`);
  }

  if (tokens.length === 0) {
    throw new PolicyError("empty command after normalization");
  }

  return {
    normalized: tokens.join(" "),
    tokens,
  };
}

function normalizeAllowedCommands(commands: string[], context: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const command of commands) {
    const { normalized, tokens } = normalizeCommand(command);
    map.set(normalized, tokens);
  }
  if (map.size === 0) {
    throw new PolicyError(`${context} is empty: DENY ALL`);
  }
  return map;
}

export function validateRepoAllowed(policy: PolicyConfig, repoName: string): string {
  const repo = (repoName ?? "").trim();
  if (!repo) {
    throw new PolicyError("repo name must be a non-empty string");
  }

  const reposAllowed = normalizeNameList(policy.repos_allowed);
  if (reposAllowed.length === 0) {
    throw new PolicyError("repos_allowed is empty: DENY ALL");
  }
  if (!reposAllowed.includes(repo)) {
    throw new PolicyError(`repo not allowed by policy: ${repo}`);
  }

  return repo;
}

export function validateAgent(policy: PolicyConfig, agentName: string): AgentConfig {
  const name = (agentName ?? "").trim();
  if (!name) {
    throw new PolicyError("agent name must be a non-empty string");
  }

  const agent = policy.agents[name];
  if (!agent) {
    throw new PolicyError(`agent not declared in policy: ${name}`);
  }

  return agent;
}

function isPathInside(basePath: string, targetPath: string, allowEqual: boolean): boolean {
  const relative = path.relative(basePath, targetPath);
  if (!relative) {
    return allowEqual;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveRepoPath(policy: PolicyConfig, repoName: string): string {
  const repo = validateRepoAllowed(policy, repoName);
  const projectsRoot = path.resolve(policy.paths.projects_root);
  const resolved = path.resolve(projectsRoot, repo);

  if (!isPathInside(projectsRoot, resolved, false)) {
    throw new PolicyError(`resolved repo path escapes projects_root: ${resolved}`);
  }

  return resolved;
}

export function validatePathsWrite(policy: PolicyConfig, targetPath: string): string {
  const target = path.resolve(targetPath);
  const roots = normalizeNameList(policy.paths.allowed_write_roots).map((root) => path.resolve(root));

  if (roots.length === 0) {
    throw new PolicyError("allowed_write_roots is empty: DENY ALL writes");
  }

  for (const root of roots) {
    if (isPathInside(root, target, true)) {
      return target;
    }
  }

  throw new PolicyError(`path not allowed for write: ${target}`);
}

export function validateCommandWhitelist(
  policy: PolicyConfig,
  agentName: string,
  command: string,
): string[] {
  const agent = validateAgent(policy, agentName);
  const { normalized, tokens } = normalizeCommand(command);
  const allowed = normalizeAllowedCommands(
    agent.commands_whitelist,
    `commands_whitelist for ${agentName}`,
  );

  if (!allowed.has(normalized)) {
    throw new PolicyError(`command not in exact whitelist for ${agentName}: '${normalized}'`);
  }

  return tokens;
}

export function validateSudoCommand(policy: PolicyConfig, agentName: string, command: string): string {
  const agent = validateAgent(policy, agentName);
  if (!agent.allow_sudo) {
    throw new PolicyError(`agent ${agentName} is not allowed to use sudo`);
  }

  const { normalized } = normalizeCommand(command);
  const allowed = normalizeAllowedCommands(
    agent.sudo_commands_allowed,
    `sudo_commands_allowed for ${agentName}`,
  );
  if (!allowed.has(normalized)) {
    throw new PolicyError(`sudo command not in exact whitelist for ${agentName}: '${normalized}'`);
  }

  return normalized;
}

export function validateStack(policy: PolicyConfig, stackName: string): string {
  const stack = (stackName ?? "").trim();
  if (!stack) {
    throw new PolicyError("stack name must be a non-empty string");
  }

  const stacksAllowed = normalizeNameList(policy.stacks_allowed);
  if (stacksAllowed.length === 0) {
    throw new PolicyError("stacks_allowed is empty: DENY ALL");
  }

  if (!stacksAllowed.includes(stack)) {
    throw new PolicyError(`stack not allowed by policy: ${stack}`);
  }

  return stack;
}
