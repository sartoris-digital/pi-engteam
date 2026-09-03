// src/v3/dag-parallel.ts — sequential DAG by default; sibling worktrees when flag on (spec §10.3).
import { matchesAny } from "../gate/glob.js";
import type { Workspace, WorkspaceProvider } from "../workspace/types.js";
import { applyFilesToWorkspace, createSiblings as defaultCreateSiblings } from "./best-of-n.js";
import { v3Enabled, type V3HostConfig } from "./dispatch.js";

export interface DagTask {
  id: string;
  dependsOn: string[];
  files: string[];
  verify?: string;
}

export interface DagPlan {
  tasks: DagTask[];
}

export type V3DagConfig = V3HostConfig;

export class PlanDagError extends Error {
  constructor(
    readonly code: "cycle" | "write-roots" | "duplicate-id" | "missing-dep",
    message: string,
  ) {
    super(message);
    this.name = "PlanDagError";
  }
}

export interface RunDagParallelOptions {
  cfg: V3DagConfig;
  primary: Workspace;
  tasks: DagTask[];
  runTask: (ws: Workspace, task: DagTask) => Promise<{ files?: Record<string, string> } | void>;
  createSiblings?: (ws: Workspace, n: number, suffix: string) => Promise<Workspace[]>;
  provider?: WorkspaceProvider;
  base?: string;
  applyFiles?: (ws: Workspace, files: Record<string, string>) => Promise<void>;
  checkpoint?: (ws: Workspace, task: DagTask) => Promise<unknown>;
  writeRoots?: string[];
}

export interface DagRunResult {
  order: string[];
  waves: string[][];
  parallel: boolean;
}

function byIdMap(tasks: DagTask[]): Map<string, DagTask> {
  const map = new Map<string, DagTask>();
  for (const t of tasks) {
    if (map.has(t.id)) throw new PlanDagError("duplicate-id", `duplicate task id ${t.id}`);
    map.set(t.id, t);
  }
  return map;
}

function assertAcyclic(tasks: DagTask[]): void {
  const ids = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) throw new PlanDagError("missing-dep", `task ${t.id} depends on unknown ${dep}`);
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.get(dep)!.push(t.id);
    }
  }
  const queue = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen += 1;
    for (const nxt of dependents.get(id) ?? []) {
      const nextDeg = (indegree.get(nxt) ?? 0) - 1;
      indegree.set(nxt, nextDeg);
      if (nextDeg === 0) queue.push(nxt);
    }
  }
  if (seen !== tasks.length) throw new PlanDagError("cycle", "plan DAG contains a cycle");
}

export function validatePlanDag(plan: DagPlan, writeRoots?: string[]): void {
  const tasks = plan.tasks;
  byIdMap(tasks);
  for (const t of tasks) {
    for (const file of t.files) {
      if (file.startsWith("/") || file.split("/").includes("..")) {
        throw new PlanDagError("write-roots", `task ${t.id} file escapes writeRoots: ${file}`);
      }
      if (writeRoots !== undefined && writeRoots.length > 0 && !matchesAny(file, writeRoots)) {
        throw new PlanDagError("write-roots", `task ${t.id} file ${file} is outside writeRoots`);
      }
    }
  }
  assertAcyclic(tasks);
}

function overlaps(files: string[], used: Set<string>): boolean {
  return files.some((f) => used.has(f));
}

export function scheduleDag(tasks: DagTask[]): string[][] {
  validatePlanDag({ tasks });
  const remaining = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const filesOf = new Map<string, string[]>();
  const orderIndex = new Map<string, number>();
  for (const [i, t] of tasks.entries()) {
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
    filesOf.set(t.id, t.files);
    orderIndex.set(t.id, i);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.get(dep)!.push(t.id);
    }
  }

  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => (indegree.get(id) ?? 0) === 0)
      .sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
    if (ready.length === 0) throw new PlanDagError("cycle", "plan DAG contains a cycle");
    const wave: string[] = [];
    const used = new Set<string>();
    for (const id of ready) {
      const files = filesOf.get(id) ?? [];
      if (wave.length > 0 && overlaps(files, used)) continue;
      wave.push(id);
      for (const f of files) used.add(f);
    }
    if (wave.length === 0) {
      const first = ready[0]!;
      wave.push(first);
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      for (const nxt of dependents.get(id) ?? []) {
        indegree.set(nxt, (indegree.get(nxt) ?? 0) - 1);
      }
    }
  }
  return waves;
}

function siblingFactory(
  opts: RunDagParallelOptions,
): (ws: Workspace, n: number, suffix: string) => Promise<Workspace[]> {
  if (opts.createSiblings !== undefined) return opts.createSiblings;
  if (opts.provider !== undefined) {
    const provider = opts.provider;
    const base = opts.base;
    return (ws, n, suffix) => defaultCreateSiblings(ws, n, suffix, { provider, base });
  }
  throw new Error("createSiblings or provider is required when v3.dagParallel is enabled");
}

export async function runDagParallel(opts: RunDagParallelOptions): Promise<DagRunResult> {
  if (opts.writeRoots !== undefined) validatePlanDag({ tasks: opts.tasks }, opts.writeRoots);
  else validatePlanDag({ tasks: opts.tasks });
  const waves = scheduleDag(opts.tasks);
  const tasksById = byIdMap(opts.tasks);
  const apply = opts.applyFiles ?? applyFilesToWorkspace;
  const parallel = v3Enabled(opts.cfg, "dagParallel");

  if (!parallel) {
    const order = waves.flat();
    for (const id of order) {
      const task = tasksById.get(id)!;
      const result = await opts.runTask(opts.primary, task);
      if (result?.files !== undefined && Object.keys(result.files).length > 0) {
        await apply(opts.primary, result.files);
      }
      if (opts.checkpoint !== undefined) await opts.checkpoint(opts.primary, task);
    }
    return { order, waves, parallel: false };
  }

  const create = siblingFactory(opts);
  const order: string[] = [];
  for (const wave of waves) {
    const ran = await Promise.all(
      wave.map(async (id) => {
        const task = tasksById.get(id)!;
        const siblings = await create(opts.primary, 1, id);
        const ws = siblings[0];
        if (ws === undefined) throw new Error(`createSiblings returned no workspace for ${id}`);
        const result = await opts.runTask(ws, task);
        return { task, files: result?.files ?? {} };
      }),
    );
    for (const r of ran) {
      order.push(r.task.id);
      if (Object.keys(r.files).length > 0) await apply(opts.primary, r.files);
      if (opts.checkpoint !== undefined) await opts.checkpoint(opts.primary, r.task);
    }
  }
  return { order, waves, parallel: true };
}
