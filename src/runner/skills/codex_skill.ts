import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { SqliteStore } from "../../db";
import { appendLog } from "../../logging";
import { PolicyError } from "../../errors";
import {
  normalizeCommand,
  resolveRepoPath,
  validateAgent,
  validateCommandWhitelist,
  validatePathsWrite,
  validateRepoAllowed,
  type PolicyConfig,
} from "../../policy";

const ALLOWED_SKILL_AGENTS = new Set([
  "TranslatorAgent",
  "PMAgent",
  "MobileAgent",
  "OCRAgent",
  "QAAgent",
  "CoderAgent",
  "BuilderAgent",
  "UXAgent",
]);

const RECOVERABLE_STDERR_HINTS = [
  "failed to record rollout items",
  "failed to queue rollout items",
  "channel closed",
  "stream disconnected",
  "error decoding response body",
  "connection reset by peer",
];

const NON_RECOVERABLE_STDERR_HINTS = [
  "permission denied",
  "command not found",
  "no such file or directory",
  "not inside a trusted directory",
  "authentication",
  "unauthorized",
  "forbidden",
  "policy_denied",
  "invalid api key",
];

function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const data = Buffer.from(value, "utf-8");
  if (data.length <= maxBytes) {
    return { text: value, truncated: false };
  }
  return {
    text: data.subarray(0, maxBytes).toString("utf-8"),
    truncated: true,
  };
}

function coerceText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf-8");
  }
  return "";
}

function isRecoverableNonZeroExit(params: {
  stderrText: string;
  diffSaved: boolean;
  workspaceDirty: boolean;
}): boolean {
  const stderrLow = params.stderrText.toLowerCase();
  if (NON_RECOVERABLE_STDERR_HINTS.some((token) => stderrLow.includes(token))) {
    return false;
  }
  if (RECOVERABLE_STDERR_HINTS.some((token) => stderrLow.includes(token))) {
    return true;
  }
  return params.diffSaved || params.workspaceDirty;
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function safeArtifactsDir(taskId: string, artifactsRoot: string, agent: string): string {
  if (!taskId || taskId.includes("/") || taskId.includes("\\")) {
    throw new PolicyError("invalid task_id for artifacts path");
  }

  const root = path.resolve(artifactsRoot);
  const target = path.resolve(path.join(root, safeSegment(agent, "agent"), taskId));
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PolicyError(`artifacts path escapes root: ${target}`);
  }

  fs.mkdirSync(target, { recursive: true });
  return target;
}

function appendEvent(eventsPath: string, eventType: string, detail: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    event: eventType,
    detail,
  };
  fs.appendFileSync(eventsPath, `${JSON.stringify(payload)}\n`, { encoding: "utf-8" });
}

function loadAgentsContext(repoPath: string): string {
  const agentsPath = path.join(repoPath, "AGENTS.md");
  if (!fs.existsSync(agentsPath) || !fs.statSync(agentsPath).isFile()) {
    return "AGENTS.md not found.";
  }
  const text = fs.readFileSync(agentsPath, "utf-8").trim();
  if (!text) {
    return "AGENTS.md exists but is empty.";
  }
  return text;
}

function buildPrompt(params: {
  requestText: string;
  repo: string;
  agent: string;
  agentsContext: string;
}): string {
  return (
    `Task request:\n${params.requestText.trim()}\n\n` +
    `Repository: ${params.repo}\n` +
    `Agent: ${params.agent}\n\n` +
    "Repository AGENTS.md context:\n" +
    `${params.agentsContext}\n\n` +
    "Execution constraints:\n" +
    "- Operate only inside the repository.\n" +
    "- Do not expose secrets.\n" +
    "- Produce minimal, reviewable changes.\n" +
    "- Summarize what changed.\n"
  );
}

function writeManualArtifacts(params: {
  artifactDir: string;
  promptPath: string;
  commandRaw: string;
  repoPath: string;
}): string {
  const runPath = path.join(params.artifactDir, "run.sh");
  const expectedPath = path.join(params.artifactDir, "expected_outputs.md");

  const script =
    "#!/usr/bin/env bash\n" +
    "set -euo pipefail\n" +
    `cd ${JSON.stringify(params.repoPath)}\n` +
    `cat ${JSON.stringify(params.promptPath)} | ${params.commandRaw}\n`;

  fs.writeFileSync(runPath, script, { encoding: "utf-8" });
  fs.chmodSync(runPath, 0o755);

  fs.writeFileSync(
    expectedPath,
    "# Expected outputs\n\n" +
      "- Execute `run.sh` from this folder.\n" +
      "- Review repo changes and generated `diff.patch`.\n" +
      "- Update task summary based on the applied changes.\n",
    { encoding: "utf-8" },
  );

  return runPath;
}

function whichExists(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { encoding: "utf-8" });
  return result.status === 0;
}

export interface CodexSkillResult {
  status: string;
  summary: string;
  exitCode: number | null;
  artifactsDir: string;
  manualRequired: boolean;
}

export function runCodexSkill(params: {
  taskId: string;
  repo: string;
  agent: string;
  requestText: string;
  commandRaw: string;
  policy: PolicyConfig;
  store: SqliteStore;
  workerUser: string;
  logPath: string;
  logsDir: string;
  artifactsRoot: string;
  commandTimeoutSec: number;
  maxOutputBytes: number;
}): CodexSkillResult {
  if (!ALLOWED_SKILL_AGENTS.has(params.agent)) {
    throw new PolicyError(`codex skill not allowed for agent: ${params.agent}`);
  }

  validateAgent(params.policy, params.agent);
  validateRepoAllowed(params.policy, params.repo);
  const repoPath = resolveRepoPath(params.policy, params.repo);

  let commandRaw = (params.commandRaw ?? "").trim();
  if (!commandRaw) {
    commandRaw = `codex exec --skip-git-repo-check --sandbox workspace-write -C ${repoPath} -`;
  }

  const argv = validateCommandWhitelist(params.policy, params.agent, commandRaw);
  const normalized = normalizeCommand(commandRaw).normalized;

  const artifactsRoot = path.resolve(params.artifactsRoot);
  validatePathsWrite(params.policy, artifactsRoot);
  const artifactDir = safeArtifactsDir(params.taskId, artifactsRoot, params.agent);
  validatePathsWrite(params.policy, artifactDir);

  const eventsPath = path.join(artifactDir, "events.jsonl");
  const summaryPath = path.join(artifactDir, "summary.md");
  const finalMessagePath = path.join(artifactDir, "final_message.txt");
  const diffPath = path.join(artifactDir, "diff.patch");

  if (!fs.existsSync(diffPath)) {
    fs.writeFileSync(diffPath, "", { encoding: "utf-8" });
  }

  const promptText = buildPrompt({
    requestText: params.requestText,
    repo: params.repo,
    agent: params.agent,
    agentsContext: loadAgentsContext(repoPath),
  });
  const promptPath = path.join(artifactDir, "prompt.txt");
  fs.writeFileSync(promptPath, promptText, { encoding: "utf-8" });

  const runPath = writeManualArtifacts({
    artifactDir,
    promptPath,
    commandRaw: normalized,
    repoPath,
  });

  params.store.insertAuditEvent({
    taskId: params.taskId,
    actorType: "agent",
    actor: params.agent,
    action: "codex_invoked",
    detail: {
      command: normalized,
      repo_path: repoPath,
      artifact_dir: artifactDir,
    },
  });
  appendEvent(eventsPath, "codex_invoked", {
    command: normalized,
    repo_path: repoPath,
    artifact_dir: artifactDir,
  });
  appendLog(params.logPath, `codex_invoked: ${normalized}`, params.logsDir);

  if (!whichExists(argv[0])) {
    const reason = "codex CLI not available";
    params.store.insertAuditEvent({
      taskId: params.taskId,
      actorType: "system",
      actor: params.workerUser,
      action: "codex_manual_required",
      detail: { reason, run_script: runPath },
    });

    const summaryMessage = `BLOCKED: codex manual required. Run ${runPath}`;
    fs.writeFileSync(
      summaryPath,
      "# Codex execution summary\n\n" +
        `Manual step required: ${reason}.\n` +
        `Run: ${runPath}\n`,
      { encoding: "utf-8" },
    );
    fs.writeFileSync(finalMessagePath, `${summaryMessage}\n`, { encoding: "utf-8" });

    appendEvent(eventsPath, "codex_manual_required", { reason, run_script: runPath });
    params.store.insertAuditEvent({
      taskId: params.taskId,
      actorType: "agent",
      actor: params.agent,
      action: "codex_result",
      detail: {
        status: "blocked",
        exit_code: null,
        timed_out: false,
        stdout: "",
        stderr: reason,
        stdout_truncated: false,
        stderr_truncated: false,
        summary_path: summaryPath,
        diff_path: diffPath,
        manual_run_script: runPath,
      },
    });
    appendEvent(eventsPath, "codex_result", {
      status: "blocked",
      exit_code: null,
      manual_required: true,
      summary: summaryMessage,
    });

    return {
      status: "blocked",
      summary: summaryMessage,
      exitCode: null,
      artifactsDir: artifactDir,
      manualRequired: true,
    };
  }

  try {
    spawnSync("git", ["config", "--global", "--add", "safe.directory", repoPath], {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 10_000,
    });
  } catch {
    // Best effort.
  }

  const cmdResult = spawnSync(argv[0], argv.slice(1), {
    cwd: repoPath,
    input: promptText,
    encoding: "utf-8",
    timeout: params.commandTimeoutSec * 1000,
    maxBuffer: Math.max(1_048_576, params.maxOutputBytes * 8),
  });

  const timedOut = cmdResult.error?.name === "Error" && String(cmdResult.error).includes("ETIMEDOUT");
  const exitCode = timedOut ? 124 : (cmdResult.status ?? (cmdResult.error ? 126 : 0));
  const stdoutRaw = coerceText(cmdResult.stdout);
  const stderrRaw = timedOut
    ? `${coerceText(cmdResult.stderr)}\nCodex command timed out.`
    : coerceText(cmdResult.stderr);

  const stdout = truncateText(stdoutRaw, params.maxOutputBytes);
  const stderr = truncateText(stderrRaw, params.maxOutputBytes);

  if (stdout.text.trim()) {
    appendLog(params.logPath, `codex_stdout:\n${stdout.text}`, params.logsDir);
  }
  if (stderr.text.trim()) {
    appendLog(params.logPath, `codex_stderr:\n${stderr.text}`, params.logsDir);
  }

  const summaryBody =
    "# Codex execution summary\n\n" +
    `- command: \`${normalized}\`\n` +
    `- exit_code: \`${exitCode}\`\n` +
    `- timed_out: \`${timedOut}\`\n\n` +
    "## stdout\n\n```\n" +
    `${stdout.text}\n` +
    "```\n\n" +
    "## stderr\n\n```\n" +
    `${stderr.text}\n` +
    "```\n";
  fs.writeFileSync(summaryPath, summaryBody, { encoding: "utf-8" });

  let diffSaved = false;
  try {
    const diffArgv = validateCommandWhitelist(params.policy, params.agent, "git diff");
    const diffResult = spawnSync(diffArgv[0], diffArgv.slice(1), {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 30_000,
    });
    const diffContent = coerceText(diffResult.stdout);
    if (diffContent.trim()) {
      fs.writeFileSync(diffPath, diffContent, { encoding: "utf-8" });
      diffSaved = true;
    }
  } catch {
    diffSaved = false;
  }

  let workspaceDirty = false;
  try {
    const statusArgv = validateCommandWhitelist(params.policy, params.agent, "git status");
    const statusResult = spawnSync(statusArgv[0], [...statusArgv.slice(1), "--short"], {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 30_000,
    });
    workspaceDirty = coerceText(statusResult.stdout).trim().length > 0;
  } catch {
    workspaceDirty = false;
  }

  const manualRequired =
    timedOut ||
    (exitCode !== 0 &&
      !isRecoverableNonZeroExit({
        stderrText: stderr.text,
        diffSaved,
        workspaceDirty,
      }));

  let status = "succeeded";
  let summary = `SUCCEEDED: codex command completed (exit_code=${exitCode})`;
  if (manualRequired) {
    const reason = timedOut
      ? "codex non-interactive execution timed out"
      : `codex non-interactive exit_code=${exitCode}`;

    params.store.insertAuditEvent({
      taskId: params.taskId,
      actorType: "system",
      actor: params.workerUser,
      action: "codex_manual_required",
      detail: { reason, run_script: runPath },
    });

    appendEvent(eventsPath, "codex_manual_required", { reason, run_script: runPath });
    status = "blocked";
    summary = `BLOCKED: ${reason}. Run ${runPath}`;
  }

  fs.writeFileSync(finalMessagePath, `${summary}\n`, { encoding: "utf-8" });

  params.store.insertAuditEvent({
    taskId: params.taskId,
    actorType: "agent",
    actor: params.agent,
    action: "codex_result",
    detail: {
      status,
      exit_code: exitCode,
      timed_out: timedOut,
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      summary_path: summaryPath,
      diff_path: diffSaved ? diffPath : null,
      manual_run_script: runPath,
    },
  });
  appendEvent(eventsPath, "codex_result", {
    status,
    exit_code: exitCode,
    timed_out: timedOut,
    manual_required: manualRequired,
    summary,
  });

  return {
    status,
    summary,
    exitCode,
    artifactsDir: artifactDir,
    manualRequired,
  };
}
