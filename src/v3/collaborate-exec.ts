import type { WorkerExecutor } from "../runtime/types.js";
import { v3Enabled, type V3HostConfig } from "./dispatch.js";

export const COLLABORATE_EXEC_CLASS = "collaborate-exec" as const;

export type CollaborateExecState = "staged" | "probationary" | "active" | "assist" | "demoted" | "retired";

export interface CollaborateExecPlanTask {
  id: string;
  dependsOn: string[];
  files: string[];
  patch?: Record<string, string>;
  verify?: string;
}

export interface CollaborateExecPlan {
  tasks: CollaborateExecPlanTask[];
}

export interface CollaborateExecRecord {
  id: string;
  class: typeof COLLABORATE_EXEC_CLASS;
  state: CollaborateExecState;
  stages?: string[];
}

export interface DagParallelFn {
  (input: {
    cfg: V3HostConfig;
    tasks: CollaborateExecPlanTask[];
    applyTask: (task: CollaborateExecPlanTask) => Promise<Record<string, string>>;
  }): Promise<{ files: Record<string, string> }>;
}

export async function sequentialDag(input: {
  tasks: CollaborateExecPlanTask[];
  applyTask: (task: CollaborateExecPlanTask) => Promise<Record<string, string>>;
}): Promise<{ files: Record<string, string> }> {
  const remaining = new Map(input.tasks.map((t) => [t.id, t]));
  const done = new Set<string>();
  const files: Record<string, string> = {};
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((t) => t.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) throw new Error("collaborate-exec: cyclic or missing DAG dependency");
    for (const task of ready) {
      Object.assign(files, await input.applyTask(task));
      done.add(task.id);
      remaining.delete(task.id);
    }
  }
  return { files };
}

export class CollaborateExecTool implements CollaborateExecRecord {
  readonly class = COLLABORATE_EXEC_CLASS;
  readonly id: string;
  readonly state: CollaborateExecState;
  readonly stages: string[];

  constructor(opts: { id: string; state: CollaborateExecState; stages?: string[] }) {
    this.id = opts.id;
    this.state = opts.state;
    this.stages = opts.stages ?? ["implement"];
  }

  async run(input: {
    plan: CollaborateExecPlan;
    runDagParallel?: DagParallelFn;
    executor?: WorkerExecutor;
    cfg?: V3HostConfig;
  }): Promise<{ files: Record<string, string>; usedExecutor: false }> {
    void input.executor;
    const applyTask = async (task: CollaborateExecPlanTask): Promise<Record<string, string>> => task.patch ?? {};
    const files = input.runDagParallel
      ? (await input.runDagParallel({ cfg: input.cfg ?? {}, tasks: input.plan.tasks, applyTask })).files
      : (await sequentialDag({ tasks: input.plan.tasks, applyTask })).files;
    return { files, usedExecutor: false };
  }
}

export function selectTool(
  stage: string,
  cfg: V3HostConfig,
  registry: Iterable<CollaborateExecRecord>,
): CollaborateExecRecord | null {
  if (!v3Enabled(cfg, "collaborateExecution")) return null;
  for (const tool of registry) {
    if (tool.class !== COLLABORATE_EXEC_CLASS) continue;
    if (tool.state !== "active") continue;
    if (tool.stages !== undefined && tool.stages.length > 0 && !tool.stages.includes(stage)) continue;
    return tool;
  }
  return null;
}

export interface V3CodifyTool {
  id: string;
  class: string;
  state: string;
  source?: "local" | "shared";
}

export interface V3CodifyRepoStats {
  shadowAgree: number;
  source?: "local" | "shared";
}

export interface V3CodifyDispatchResult {
  exact: boolean;
  reason: string;
}

export function v3CodifyDispatch(
  cfg: V3HostConfig,
  tool: V3CodifyTool,
  repoStats: V3CodifyRepoStats,
): V3CodifyDispatchResult {
  if (cfg.codify?.dispatch === "off") {
    return { exact: false, reason: "codify-dispatch-off" };
  }
  const source = tool.source ?? repoStats.source ?? "local";
  if (source === "shared") {
    if (!v3Enabled(cfg, "crossRepoTools")) {
      return { exact: false, reason: "cross-repo-flag-off" };
    }
    const need = cfg.codify?.shadowAgreeToActivate ?? 2;
    if (repoStats.shadowAgree < need) {
      return { exact: false, reason: "shadow-count" };
    }
    if (tool.state !== "active") return { exact: false, reason: "not-active" };
    return { exact: true, reason: "cross-repo-earned" };
  }
  if (tool.class === COLLABORATE_EXEC_CLASS) {
    if (!v3Enabled(cfg, "collaborateExecution")) {
      return { exact: false, reason: "collaborate-exec-flag-off" };
    }
    if (tool.state !== "active") return { exact: false, reason: "not-active" };
    return { exact: true, reason: "collaborate-exec" };
  }
  return { exact: false, reason: "v1.5-local" };
}
