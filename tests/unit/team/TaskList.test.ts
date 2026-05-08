import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadTasks,
  saveTasks,
  unassignedTasks,
  liveTasks,
  createTaskListTool,
  createTaskUpdateTool,
  type Task,
} from "../../../src/team/tools/TaskList.js";

let runsDir: string;
const runId = "r1";

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "tasklist-"));
});

function callTool(tool: any, args: Record<string, unknown>): Promise<any> {
  return tool.execute("test-id", args);
}

describe("TaskList — Phase 5.5 §9.2 team metadata", () => {
  it("loadTasks returns [] when tasks.json missing", async () => {
    const t = await loadTasks(runsDir, runId);
    expect(t).toEqual([]);
  });

  it("saveTasks + loadTasks round-trip with team field", async () => {
    const tasks: Task[] = [
      { taskId: "t-1", status: "pending", team: "engineering", updatedAt: "x" },
      { taskId: "t-2", status: "in_progress", updatedAt: "x" },
    ];
    await saveTasks(runsDir, runId, tasks);
    const loaded = await loadTasks(runsDir, runId);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].team).toBe("engineering");
    expect(loaded[1].team).toBeUndefined();
  });

  it("unassignedTasks filters out completed and team-tagged tasks", () => {
    const tasks: Task[] = [
      { taskId: "t-1", status: "pending", team: "engineering", updatedAt: "x" },
      { taskId: "t-2", status: "pending", updatedAt: "x" },
      { taskId: "t-3", status: "completed", updatedAt: "x" },
      { taskId: "t-4", status: "in_progress", updatedAt: "x" },
    ];
    const u = unassignedTasks(tasks);
    expect(u.map((t) => t.taskId).sort()).toEqual(["t-2", "t-4"]);
  });

  it("liveTasks filters to pending/in_progress only", () => {
    const tasks: Task[] = [
      { taskId: "t-1", status: "pending", updatedAt: "x" },
      { taskId: "t-2", status: "in_progress", updatedAt: "x" },
      { taskId: "t-3", status: "completed", updatedAt: "x" },
      { taskId: "t-4", status: "blocked", updatedAt: "x" },
    ];
    const l = liveTasks(tasks);
    expect(l.map((t) => t.taskId).sort()).toEqual(["t-1", "t-2"]);
  });

  it("TaskUpdate persists optional team field on create + update", async () => {
    const tool = createTaskUpdateTool(runsDir, runId);
    await callTool(tool, { taskId: "t-1", status: "pending", team: "validation" });
    let raw = JSON.parse(await readFile(join(runsDir, runId, "tasks.json"), "utf8")) as Task[];
    expect(raw[0].team).toBe("validation");
    // Update later with team=engineering — must overwrite.
    await callTool(tool, { taskId: "t-1", status: "in_progress", team: "engineering" });
    raw = JSON.parse(await readFile(join(runsDir, runId, "tasks.json"), "utf8")) as Task[];
    expect(raw[0].team).toBe("engineering");
    expect(raw[0].status).toBe("in_progress");
  });

  it("TaskUpdate without team leaves task as unassigned", async () => {
    const tool = createTaskUpdateTool(runsDir, runId);
    await callTool(tool, { taskId: "t-7", status: "pending" });
    const raw = JSON.parse(await readFile(join(runsDir, runId, "tasks.json"), "utf8")) as Task[];
    expect(raw[0].team).toBeUndefined();
    const unassigned = unassignedTasks(raw);
    expect(unassigned).toHaveLength(1);
  });

  it("TaskList filters by team", async () => {
    await saveTasks(runsDir, runId, [
      { taskId: "t-eng", status: "pending", team: "engineering", updatedAt: "x" },
      { taskId: "t-val", status: "pending", team: "validation", updatedAt: "x" },
      { taskId: "t-no", status: "pending", updatedAt: "x" },
    ]);
    const tool = createTaskListTool(runsDir, runId);
    const all = await callTool(tool, {});
    const allArr = JSON.parse(all.content[0].text);
    expect(allArr).toHaveLength(3);
    const eng = await callTool(tool, { team: "engineering" });
    const engArr = JSON.parse(eng.content[0].text);
    expect(engArr).toHaveLength(1);
    expect(engArr[0].taskId).toBe("t-eng");
  });
});
