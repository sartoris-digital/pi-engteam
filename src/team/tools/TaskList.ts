import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

type Task = {
  taskId: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  notes?: string;
  owner?: string;
  updatedAt: string;
};

async function loadTasks(runsDir: string, runId: string): Promise<Task[]> {
  const path = join(runsDir, runId, "tasks.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as Task[];
  } catch {
    return [];
  }
}

async function saveTasks(runsDir: string, runId: string, tasks: Task[]): Promise<void> {
  const dir = join(runsDir, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2));
}

export function createTaskListTool(runsDir: string, runId: string) {
  return defineTool({
    name: "TaskList",
    label: "List Tasks",
    description: "List all tasks for the current run",
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      const tasks = await loadTasks(runsDir, runId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }],
        details: {},
      };
    },
  });
}

export function createTaskUpdateTool(runsDir: string, runId: string) {
  return defineTool({
    name: "TaskUpdate",
    label: "Update Task",
    description: "Create or update a task's status",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID" }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("blocked"),
      ]),
      notes: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const tasks = await loadTasks(runsDir, runId);
      const existing = tasks.find(t => t.taskId === params.taskId);
      if (existing) {
        existing.status = params.status;
        existing.updatedAt = new Date().toISOString();
        if (params.notes) existing.notes = params.notes;
        if (params.owner) existing.owner = params.owner;
      } else {
        tasks.push({
          taskId: params.taskId,
          status: params.status,
          notes: params.notes,
          owner: params.owner,
          updatedAt: new Date().toISOString(),
        });
      }
      await saveTasks(runsDir, runId, tasks);
      return {
        content: [{ type: "text" as const, text: `Task ${params.taskId} updated: ${params.status}` }],
        details: {},
      };
    },
  });
}
