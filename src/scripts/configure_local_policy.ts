import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";
import yaml from "js-yaml";

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CODEX_CMD_RE = /^codex exec(\s|$)/;

function parseRepos(raw: string): string[] {
  const values: string[] = [];
  for (const item of raw.split(",")) {
    const repo = item.trim();
    if (!repo) {
      continue;
    }
    if (!REPO_NAME_RE.test(repo)) {
      throw new Error(`invalid repo name: ${repo}`);
    }
    if (!values.includes(repo)) {
      values.push(repo);
    }
  }
  if (values.length === 0) {
    throw new Error("repos list is empty");
  }
  return values;
}

function codexCommand(repo: string, projectsRoot: string): string {
  return `codex exec --skip-git-repo-check --sandbox workspace-write -C ${projectsRoot}/${repo} -`;
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const item of values) {
    if (!out.includes(item)) {
      out.push(item);
    }
  }
  return out;
}

function rewriteAgentCommands(params: {
  agentConfig: Record<string, unknown>;
  repos: string[];
  projectsRoot: string;
}): void {
  const commands = params.agentConfig.commands_whitelist;
  if (!Array.isArray(commands)) {
    return;
  }

  const preserved = commands.filter(
    (value): value is string => typeof value === "string" && !CODEX_CMD_RE.test(value.trim()),
  );
  const codexValues = params.repos.map((repo) => codexCommand(repo, params.projectsRoot));
  params.agentConfig.commands_whitelist = dedupe([...preserved, ...codexValues]);
}

function parseArgs(argv: string[]): { policyFile: string; repos: string; projectsRoot: string } {
  const program = new Command();
  program
    .requiredOption("--policy-file <path>")
    .requiredOption("--repos <csv>")
    .option("--projects-root <path>", "Projects root", "/srv/projects");
  program.parse(argv);
  const opts = program.opts<Record<string, string>>();
  return {
    policyFile: String(opts.policyFile),
    repos: String(opts.repos),
    projectsRoot: String(opts.projectsRoot),
  };
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const policyPath = path.resolve(args.policyFile);
  if (!fs.existsSync(policyPath) || !fs.statSync(policyPath).isFile()) {
    throw new Error(`[FAIL] policy file not found: ${policyPath}`);
  }

  const repos = parseRepos(args.repos);
  const projectsRoot = args.projectsRoot.replace(/\/+$/, "");
  if (!projectsRoot.startsWith("/")) {
    throw new Error(`[FAIL] projects_root must be absolute: ${projectsRoot}`);
  }

  const raw = yaml.load(fs.readFileSync(policyPath, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`[FAIL] invalid policy format in ${policyPath}`);
  }

  const policy = raw as Record<string, unknown>;
  policy.repos_allowed = repos;

  if (policy.paths && typeof policy.paths === "object" && !Array.isArray(policy.paths)) {
    (policy.paths as Record<string, unknown>).projects_root = projectsRoot;
  }

  if (policy.agents && typeof policy.agents === "object" && !Array.isArray(policy.agents)) {
    for (const value of Object.values(policy.agents as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        rewriteAgentCommands({
          agentConfig: value as Record<string, unknown>,
          repos,
          projectsRoot,
        });
      }
    }
  }

  fs.writeFileSync(policyPath, yaml.dump(policy, { sortKeys: false, noRefs: true }), {
    encoding: "utf-8",
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        policy_file: policyPath,
        repos_allowed: repos,
        projects_root: projectsRoot,
      },
      null,
      0,
    ),
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}
