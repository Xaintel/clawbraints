import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { applyPatchLocal, ClawBrainIDEClient, IDEClientError } from "./client";
import { ConfigError, loadConfig, saveConfig } from "./config";
import {
  PMOrchestratorError,
  buildInterviewFromPayload,
  buildPmPlan,
  dispatchPmPlan,
  translateSimpleRequest,
} from "./pm_orchestrator";

function jsonDump(value: unknown): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(value, null, 2));
}

function buildClient(requireToken = true): ClawBrainIDEClient {
  const config = loadConfig({ requireToken });
  return new ClawBrainIDEClient(config);
}

function promptText(question: string, options?: { defaultValue?: string; required?: boolean }): string {
  while (true) {
    const suffix = options?.defaultValue ? ` [${options.defaultValue}]` : "";
    process.stdout.write(`${question}${suffix}: `);
    const answerRaw = fs.readFileSync(0, "utf-8");
    const firstLine = answerRaw.split(/\r?\n/)[0] ?? "";
    const answer = firstLine.trim() || options?.defaultValue?.trim() || "";

    if (options?.required && !answer) {
      // eslint-disable-next-line no-console
      console.log("Campo requerido.");
      continue;
    }
    return answer;
  }
}

function resolvePmField(params: {
  value?: string;
  question: string;
  defaultValue?: string;
  required: boolean;
  interactive: boolean;
}): string {
  const cleaned = String(params.value ?? "").trim();
  if (cleaned) {
    return cleaned;
  }
  if (params.interactive) {
    return promptText(params.question, {
      defaultValue: params.defaultValue,
      required: params.required,
    });
  }
  if (params.required) {
    throw new IDEClientError(`missing required field in non-interactive mode: ${params.question}`);
  }
  return String(params.defaultValue ?? "").trim();
}

async function dispatchOrCancel(params: {
  planOutput: Record<string, unknown>;
  plan: ReturnType<typeof buildPmPlan>;
  yes: boolean;
  dryRun: boolean;
  interactive: boolean;
}): Promise<number> {
  if (params.dryRun) {
    jsonDump(params.planOutput);
    return 0;
  }

  if (!params.yes) {
    if (!params.interactive) {
      throw new IDEClientError("non-interactive mode requires --yes or --dry-run");
    }

    // eslint-disable-next-line no-console
    console.log(`\n${params.plan.summary}`);
    for (const task of params.plan.tasks) {
      // eslint-disable-next-line no-console
      console.log(`- ${task.order}. ${task.agent}: ${task.reason}`);
    }

    process.stdout.write("Despachar tareas ahora? [y/N]: ");
    const confirmRaw = fs.readFileSync(0, "utf-8");
    const confirm = (confirmRaw.split(/\r?\n/)[0] ?? "").trim().toLowerCase();
    if (!["y", "yes", "s", "si"].includes(confirm)) {
      params.planOutput.dispatch = {
        summary: "dispatch_cancelled",
        queued_count: 0,
        failed_count: 0,
        queued: [],
        failed: [],
      };
      jsonDump(params.planOutput);
      return 0;
    }
  }

  const client = buildClient(true);
  const dispatch = await dispatchPmPlan({
    plan: params.plan,
    createTask: async (payload) => client.createTask(payload),
  });
  params.planOutput.dispatch = dispatch;
  jsonDump(params.planOutput);
  return Number(dispatch.failed_count ?? 0) === 0 ? 0 : 1;
}

function buildProgram(): Command {
  const program = new Command();
  program.name("clawbrain-ide").description("ClawBrain IDE local gateway CLI");

  program
    .command("config-show")
    .description("Show resolved configuration")
    .action(() => {
      const config = loadConfig({ requireToken: false });
      jsonDump({
        config_path: config.configPath,
        server_url: config.serverUrl,
        token_configured: Boolean(config.token),
        timeout_sec: config.timeoutSec,
      });
    });

  program
    .command("config-set")
    .description("Store local configuration")
    .option("--server-url <url>")
    .option("--token <token>")
    .option("--timeout-sec <sec>")
    .action((opts: Record<string, string | undefined>) => {
      const output = saveConfig({
        serverUrl: opts.serverUrl,
        token: opts.token,
        timeoutSec: opts.timeoutSec ? Number(opts.timeoutSec) : undefined,
      });
      // eslint-disable-next-line no-console
      console.log(`saved config: ${output}`);
    });

  program
    .command("agents")
    .description("List IDE agents")
    .action(async () => {
      jsonDump(await buildClient(true).listAgents());
    });

  program
    .command("create-task")
    .description("Create IDE task")
    .requiredOption("--repo <repo>")
    .requiredOption("--agent <agent>")
    .requiredOption("--request-text <text>")
    .option("--type <type>", "command|codex", "codex")
    .option("--command <command>")
    .option("--prompt <prompt>")
    .option("--constraints-json <json>")
    .action(async (opts: Record<string, string | undefined>) => {
      let constraints: Record<string, unknown> = {};
      if (opts.constraintsJson) {
        try {
          const parsed = JSON.parse(opts.constraintsJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("must be object");
          }
          constraints = parsed as Record<string, unknown>;
        } catch (error) {
          throw new IDEClientError(`invalid --constraints-json: ${String(error)}`);
        }
      }

      jsonDump(
        await buildClient(true).createTask({
          type: opts.type ?? "codex",
          repo: String(opts.repo ?? ""),
          agent: String(opts.agent ?? ""),
          request_text: String(opts.requestText ?? ""),
          prompt: opts.prompt,
          command: opts.command,
          constraints,
        }),
      );
    });

  program
    .command("get-task")
    .description("Get IDE task")
    .argument("<task_id>")
    .action(async (taskId: string) => {
      jsonDump(await buildClient(true).getTask(taskId));
    });

  program
    .command("wait-task")
    .description("Wait until task reaches terminal status")
    .argument("<task_id>")
    .option("--timeout-sec <sec>", "Timeout seconds", "180")
    .option("--poll-interval-sec <sec>", "Poll interval seconds", "2")
    .option("--success-statuses <csv>", "Success statuses", "succeeded,blocked")
    .option("--error-statuses <csv>", "Error statuses", "failed,canceled")
    .action(async (taskId: string, opts: Record<string, string>) => {
      const success = new Set(
        String(opts.successStatuses ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
      const errors = new Set(
        String(opts.errorStatuses ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );

      jsonDump(
        await buildClient(true).waitTask({
          taskId,
          timeoutSec: Number(opts.timeoutSec ?? 180),
          pollIntervalSec: Number(opts.pollIntervalSec ?? 2),
          successStatuses: success,
          errorStatuses: errors,
        }),
      );
    });

  program
    .command("get-logs")
    .description("Fetch task logs")
    .argument("<task_id>")
    .option("--max-bytes <bytes>", "Max bytes", "8192")
    .action(async (taskId: string, opts: Record<string, string>) => {
      jsonDump(await buildClient(true).getLogs(taskId, Number(opts.maxBytes ?? 8192)));
    });

  program
    .command("get-diff")
    .description("Fetch task diff.patch")
    .argument("<task_id>")
    .option("--output <path>")
    .action(async (taskId: string, opts: Record<string, string | undefined>) => {
      const diff = await buildClient(true).getDiff(taskId);
      if (opts.output) {
        const output = path.resolve(opts.output);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, diff, { encoding: "utf-8" });
        // eslint-disable-next-line no-console
        console.log(`saved diff: ${output}`);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(diff);
    });

  program
    .command("list-artifacts")
    .description("List task artifacts")
    .argument("<task_id>")
    .action(async (taskId: string) => {
      jsonDump(await buildClient(true).listArtifacts(taskId));
    });

  program
    .command("get-artifact")
    .description("Download specific task artifact")
    .argument("<task_id>")
    .argument("<name>")
    .option("--output <path>")
    .action(async (taskId: string, name: string, opts: Record<string, string | undefined>) => {
      const raw = await buildClient(true).getArtifact(taskId, name);
      if (opts.output) {
        const output = path.resolve(opts.output);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, raw);
        // eslint-disable-next-line no-console
        console.log(`saved artifact: ${output}`);
        return;
      }
      try {
        // eslint-disable-next-line no-console
        console.log(raw.toString("utf-8"));
      } catch {
        // eslint-disable-next-line no-console
        console.log(`<binary ${raw.length} bytes>`);
      }
    });

  program
    .command("apply-patch-local")
    .description("Apply patch locally with confirmation")
    .requiredOption("--patch <path>")
    .option("--repo <path>", "Repo path", ".")
    .option("--yes", "Do not ask for confirmation", false)
    .option("--index", "Use git apply --index", false)
    .action((opts: Record<string, string | boolean>) => {
      jsonDump(
        applyPatchLocal({
          patchPath: String(opts.patch),
          repoPath: String(opts.repo ?? "."),
          yes: Boolean(opts.yes),
          index: Boolean(opts.index),
        }),
      );
    });

  program
    .command("pm-run")
    .description("Interview -> plan -> dispatch tasks as PM agent")
    .option("--repo <repo>")
    .option("--goal <goal>")
    .option("--request-text <goal>")
    .option("--current-state <text>")
    .option("--deliverables <text>")
    .option("--constraints <text>")
    .option("--definition-done <text>")
    .option("--priority <priority>")
    .option("--needs-ux <auto|yes|no>")
    .option("--needs-builder <auto|yes|no>")
    .option("--dry-run", "Do not dispatch", false)
    .option("--yes", "Auto-confirm dispatch", false)
    .option("--non-interactive", "Disable prompts", false)
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      const interactive = !Boolean(opts.nonInteractive) && process.stdin.isTTY;

      const payload: Record<string, unknown> = {
        repo: resolvePmField({
          value: opts.repo as string | undefined,
          question: "Repo objetivo",
          required: true,
          interactive,
        }),
        goal: resolvePmField({
          value: (opts.goal as string | undefined) ?? (opts.requestText as string | undefined),
          question: "Objetivo principal",
          required: true,
          interactive,
        }),
        current_state: resolvePmField({
          value: opts.currentState as string | undefined,
          question: "Estado actual o problema",
          defaultValue: "No contexto tecnico adicional del usuario.",
          required: false,
          interactive,
        }),
        deliverables: resolvePmField({
          value: opts.deliverables as string | undefined,
          question: "Entregables esperados",
          defaultValue: "Cambios en codigo mas resumen corto de implementacion.",
          required: false,
          interactive,
        }),
        constraints: resolvePmField({
          value: opts.constraints as string | undefined,
          question: "Restricciones o limites",
          defaultValue: "No romper comportamiento existente. Cambios minimos y revisables.",
          required: false,
          interactive,
        }),
        definition_done: resolvePmField({
          value: opts.definitionDone as string | undefined,
          question: "Definicion de terminado",
          defaultValue: "Implementado, validado y documentado en resumen final.",
          required: false,
          interactive,
        }),
        priority: resolvePmField({
          value: opts.priority as string | undefined,
          question: "Prioridad (critical|high|normal|low)",
          defaultValue: "normal",
          required: false,
          interactive,
        }),
        needs_ux: resolvePmField({
          value: opts.needsUx as string | undefined,
          question: "Incluir UXAgent? (auto|yes|no)",
          defaultValue: "auto",
          required: false,
          interactive,
        }),
        needs_builder: resolvePmField({
          value: opts.needsBuilder as string | undefined,
          question: "Incluir BuilderAgent? (auto|yes|no)",
          defaultValue: "auto",
          required: false,
          interactive,
        }),
      };

      const interview = buildInterviewFromPayload(payload);
      const plan = buildPmPlan(interview);
      const output: Record<string, unknown> = { plan };
      process.exitCode = await dispatchOrCancel({
        planOutput: output,
        plan,
        yes: Boolean(opts.yes),
        dryRun: Boolean(opts.dryRun),
        interactive,
      });
    });

  program
    .command("pm-simple")
    .description("Translate simple words into PM plan and dispatch tasks")
    .option("--repo <repo>")
    .option("--text <text>")
    .option("--request-text <text>")
    .option("--priority <priority>")
    .option("--needs-ux <auto|yes|no>")
    .option("--needs-builder <auto|yes|no>")
    .option("--dry-run", "Do not dispatch", false)
    .option("--yes", "Auto-confirm dispatch", false)
    .option("--non-interactive", "Disable prompts", false)
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      const interactive = !Boolean(opts.nonInteractive) && process.stdin.isTTY;

      const repo = resolvePmField({
        value: opts.repo as string | undefined,
        question: "Repo objetivo",
        required: true,
        interactive,
      });
      const text = resolvePmField({
        value: (opts.text as string | undefined) ?? (opts.requestText as string | undefined),
        question: "Explicalo en palabras simples",
        required: true,
        interactive,
      });

      const translation = translateSimpleRequest({
        repo,
        text,
        priority: (opts.priority as string | undefined) ?? null,
        needs_ux: (opts.needsUx as string | undefined) ?? null,
        needs_builder: (opts.needsBuilder as string | undefined) ?? null,
      });
      const interview = buildInterviewFromPayload(translation.interview_payload);
      const plan = buildPmPlan(interview);
      const output: Record<string, unknown> = {
        translation,
        plan,
      };

      process.exitCode = await dispatchOrCancel({
        planOutput: output,
        plan,
        yes: Boolean(opts.yes),
        dryRun: Boolean(opts.dryRun),
        interactive,
      });
    });

  return program;
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    const program = buildProgram();
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof IDEClientError || error instanceof PMOrchestratorError) {
      // eslint-disable-next-line no-console
      console.error(`[FAIL] ${error.message}`);
      return 1;
    }
    // eslint-disable-next-line no-console
    console.error(`[FAIL] ${String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  void runCli(process.argv).then((code) => process.exit(code));
}
