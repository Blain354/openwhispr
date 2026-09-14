import type { ToolDefinition, ToolResult } from "../../services/tools/ToolRegistry";
import { toToolResult } from "./os";

type WorkerOp = "workers.delegate" | "workers.list" | "workers.cancel";

async function invoke(
  op: WorkerOp,
  payload: Record<string, unknown>,
  isAllowed: () => boolean
): Promise<ToolResult> {
  const api = window.conversationAPI;
  if (!api || !isAllowed()) {
    return toToolResult({
      success: false,
      displayText: "Background tasks are only available in a voice session.",
    });
  }
  try {
    return toToolResult((await api.invoke(op, payload)) as Parameters<typeof toToolResult>[0]);
  } catch (error) {
    return toToolResult({ success: false, displayText: (error as Error).message || "Failed." });
  }
}

/**
 * Background workers send instructions and the files they read to Anthropic, so these tools exist
 * only in the voice session window, where every delegation is confirmed on screen.
 */
export function createWorkerTools(isAllowed: () => boolean): ToolDefinition[] {
  return [
    {
      name: "delegate_task",
      description:
        "Start a longer task in the background with Claude Code, for anything that needs reading a project's files or git history (for example: summarize today's commits in a project, explain how a feature works, review recent changes). The worker can only read. The user confirms on screen and is told when it finishes; after calling this, do not describe the task again.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title, a few words" },
          prompt: {
            type: "string",
            description: "Complete instructions for the worker, in the user's language",
          },
          project: {
            type: "string",
            description: "Project folder name, as the user said it",
          },
        },
        required: ["title", "prompt", "project"],
        additionalProperties: false,
      },
      readOnly: false,
      execute: (args) =>
        invoke(
          "workers.delegate",
          {
            title: String(args.title ?? ""),
            prompt: String(args.prompt ?? ""),
            project: String(args.project ?? ""),
          },
          isAllowed
        ),
    },
    {
      name: "list_tasks",
      description: "List the background tasks with their status.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      execute: () => invoke("workers.list", {}, isAllowed),
    },
    {
      name: "cancel_task",
      description: "Cancel a queued or running background task by its id.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "Task id from list_tasks" } },
        required: ["task_id"],
        additionalProperties: false,
      },
      readOnly: false,
      execute: (args) =>
        invoke("workers.cancel", { taskId: String(args.task_id ?? "") }, isAllowed),
    },
  ];
}
