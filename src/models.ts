import { z } from "zod";

export const taskTypeSchema = z.enum(["command", "codex"]);

const baseTaskCreateRequestSchema = z.object({
  type: taskTypeSchema.default("command"),
  repo: z.string().min(1),
  agent: z.string().min(1),
  command: z.string().optional().nullable(),
  prompt: z.string().optional().nullable(),
  request_text: z.string().optional().nullable(),
});

function withTaskValidation<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((payload: z.infer<T>, context) => {
    const command = payload.command?.trim() ?? "";
    const prompt = payload.prompt?.trim() ?? "";
    const requestText = payload.request_text?.trim() ?? "";

    if (payload.type === "command" && !command) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "command is required when type=command",
      });
    }

    if (!prompt && !requestText) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["request_text"],
        message: "request_text or prompt is required",
      });
    }
  });
}

export const taskCreateRequestSchema = withTaskValidation(baseTaskCreateRequestSchema);

export const ideTaskCreateRequestSchema = withTaskValidation(
  baseTaskCreateRequestSchema.extend({
    constraints: z.record(z.unknown()).default({}),
  }),
);

export interface IdeApplyInstructions {
  mode: "manual_confirm";
  steps: string[];
}

export function buildApplyInstructions(taskId: string): IdeApplyInstructions {
  return {
    mode: "manual_confirm",
    steps: [
      `Descarga artifacts y diff desde /api/ide/tasks/${taskId}/artifacts y /api/ide/tasks/${taskId}/diff`,
      "Revisa el patch en tu IDE local",
      "Aplica cambios localmente con confirmacion explicita (ej: git apply diff.patch)",
    ],
  };
}
