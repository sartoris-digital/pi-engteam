import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

// Phase 5.5 §9.2: TillDone team metadata. The optional `team` field lets
// the Orchestrator route tasks to the appropriate Lead. Tasks created
// without a team field are *unassigned* — ADWEngine surfaces a reminder
// at the Orchestrator's next turn so it can issue a TaskUpdate({team})
// per task.
export type Team = "engineering" | "validation" | "investigation" | "planning" | "cross-functional";

// Round-1 C1: taskId enters the Orchestrator's system prompt verbatim via
// the unassigned-tasks reminder. Constrain to a safe identifier pattern
// at write time so a worker can't smuggle a prompt-injection payload as
// the taskId. Same shape as runId / agentName.
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isValidTaskId(id: string): boolean {
  return typeof id === "string" && TASK_ID_RE.test(id);
}

// Round-1 C2: runId is path-joined into runsDir for tasks.json access.
// Reject anything that could escape runsDir.
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function ensureSafeRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`Refusing tasks.json access for unsafe runId: ${runId}`);
  }
}

export type Task = {
  taskId: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  notes?: string;
  owner?: string;
  team?: Team;
  updatedAt: string;
};

export async function loadTasks(runsDir: string, runId: string): Promise<Task[]> {
  ensureSafeRunId(runId);
  const path = join(runsDir, runId, "tasks.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    // Round-2 C2 defense-in-depth: filter records that don't conform.
    // A worker that bypassed TaskUpdate (e.g., direct file write before
    // Layer A blocked it, or a stale file from before the validator
    // shipped) could otherwise feed garbage downstream.
    const out: Task[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      if (typeof t.taskId !== "string" || !TASK_ID_RE.test(t.taskId)) continue;
      const status = t.status;
      if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "blocked") continue;
      const team = t.team;
      const validTeam = !team || team === "engineering" || team === "validation" || team === "investigation" || team === "planning" || team === "cross-functional";
      if (!validTeam) continue;
      out.push({
        taskId: t.taskId,
        status: t.status as Task["status"],
        notes: typeof t.notes === "string" ? t.notes : undefined,
        owner: typeof t.owner === "string" ? t.owner : undefined,
        team: team as Task["team"],
        updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : new Date().toISOString(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveTasks(runsDir: string, runId: string, tasks: Task[]): Promise<void> {
  ensureSafeRunId(runId);
  const dir = join(runsDir, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2));
}

/**
 * Phase 5.5 §9.2: tasks without a `team` are unassigned. Orchestrator's
 * next-turn reminder pulls these so it can assign each task to the team
 * whose Lead should own it.
 */
export function unassignedTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.team && t.status !== "completed");
}

/**
 * Tasks still pending or in flight at end of Orchestrator turn — used
 * for the mark-on-complete nudge.
 */
export function liveTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
}

export function createTaskListTool(runsDir: string, runId: string) {
  return defineTool({
    name: "TaskList",
    label: "List Tasks",
    description: "List all tasks for the current run. Optionally filter by team.",
    parameters: Type.Object({
      team: Type.Optional(Type.Union([
        Type.Literal("engineering"),
        Type.Literal("validation"),
        Type.Literal("investigation"),
        Type.Literal("planning"),
        Type.Literal("cross-functional"),
      ], { description: "Optional team filter" })),
    }),
    execute: async (_id, params) => {
      const all = await loadTasks(runsDir, runId);
      const tasks = params.team ? all.filter((t) => t.team === params.team) : all;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }],
        details: {},
      };
    },
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const suffix = args.team ? ` (team=${args.team})` : "";
      text.setText(theme.fg("muted", `list tasks${suffix}`));
      return text;
    },
    renderResult(result, _options, _theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const raw = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map(c => c.text)
        .join("");
      try {
        const tasks = JSON.parse(raw) as Task[];
        text.setText(tasks.length === 0 ? "(no tasks)" : tasks.map(t => {
          const team = t.team ? ` [${t.team}]` : " [unassigned]";
          return `${t.taskId}  ${t.status}${team}`;
        }).join("\n"));
      } catch {
        text.setText(raw);
      }
      return text;
    },
  });
}

export function createTaskUpdateTool(runsDir: string, runId: string) {
  return defineTool({
    name: "TaskUpdate",
    label: "Update Task",
    description: "Create or update a task's status. Optional team field assigns the task to a specific Lead.",
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
      team: Type.Optional(Type.Union([
        Type.Literal("engineering"),
        Type.Literal("validation"),
        Type.Literal("investigation"),
        Type.Literal("planning"),
        Type.Literal("cross-functional"),
      ], { description: "Owning team. Orchestrator assigns; Leads/workers may emit without team and let Orchestrator backfill." })),
    }),
    execute: async (_id, params) => {
      // Round-1 C1: validate taskId at write boundary.
      if (!isValidTaskId(params.taskId)) {
        return {
          content: [{
            type: "text" as const,
            text: `TaskUpdate refused: taskId must match ${TASK_ID_RE.source}.`,
          }],
          details: {},
        };
      }
      const tasks = await loadTasks(runsDir, runId);
      const existing = tasks.find(t => t.taskId === params.taskId);
      if (existing) {
        existing.status = params.status;
        existing.updatedAt = new Date().toISOString();
        if (params.notes) existing.notes = params.notes;
        if (params.owner) existing.owner = params.owner;
        if (params.team) existing.team = params.team;
      } else {
        tasks.push({
          taskId: params.taskId,
          status: params.status,
          notes: params.notes,
          owner: params.owner,
          team: params.team,
          updatedAt: new Date().toISOString(),
        });
      }
      await saveTasks(runsDir, runId, tasks);
      return {
        content: [{ type: "text" as const, text: `Task ${params.taskId} updated: ${params.status}${params.team ? ` (team=${params.team})` : ""}` }],
        details: {},
      };
    },
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const color = args.status === "completed" ? "success" : args.status === "blocked" ? "error" : "accent";
      const teamSuffix = args.team ? `  ${theme.fg("muted", `[${args.team}]`)}` : "";
      text.setText(`${theme.fg("muted", args.taskId)}  ${theme.fg(color, args.status)}${teamSuffix}`);
      return text;
    },
    renderResult(result, _options, _theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(
        result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map(c => c.text)
          .join(""),
      );
      return text;
    },
  });
}
