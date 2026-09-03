import type { StepResult } from "../engine/types.js";
import type { SlotResult } from "./types.js";

/**
 * collaborate — the PLANNING half of the collaborate mode.
 *
 * Every slot plans read-only in parallel (the fan-out in run.ts already does that); this
 * module merges the architect proposal into ONE validated task DAG. Parallel multi-writer
 * execution is out of scope: the single-writer rule stands and the implementer walks the
 * DAG in `levels` order. `levels` is a dependency/parallelism PREVIEW, not a schedule.
 */

export interface CollaborateTask {
  id: string;
  assignee: string;
  dependsOn: string[];
  files: string[];
  verify: string;
  description: string;
}

export interface CollaboratePlan {
  tasks: CollaborateTask[];
  levels: string[][];
}

export type CollaborateValidation = { ok: true; plan: CollaboratePlan } | { ok: false; errors: string[] };

const FENCE = /```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)```/g;

/**
 * Every balanced `{...}` slice, string- and escape-aware, widest first — prose that itself
 * contains a stray brace must not hide the plan object nested inside it.
 */
function objectSlices(source: string): string[] {
  const out: string[] = [];
  const opens: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") opens.push(i);
    else if (ch === "}") {
      const start = opens.pop();
      if (start !== undefined) out.push(source.slice(start, i + 1));
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Tolerant extraction: a fenced block first, then the bare text, then any embedded object. */
export function parseCollaboratePlan(text: string): unknown {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return undefined;
  const sources: string[] = [];
  for (const match of trimmed.matchAll(FENCE)) {
    const body = (match[1] ?? "").trim();
    if (body !== "") sources.push(body);
  }
  sources.push(trimmed);
  for (const source of sources) {
    for (const candidate of [source, ...objectSlices(source)]) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed !== null && typeof parsed === "object") return parsed;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): { list: string[]; valid: boolean } {
  if (!Array.isArray(value)) return { list: [], valid: false };
  const list: string[] = [];
  for (const item of value) {
    const entry = asString(item);
    if (typeof item !== "string" || entry === "") return { list, valid: false };
    list.push(entry);
  }
  return { list, valid: true };
}

/** DFS over `task -> dependency` edges; returns the cycle path with the entry node repeated. */
function findCycle(byId: ReadonlyMap<string, CollaborateTask>): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    path.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) continue;
      const seen = state.get(dep);
      if (seen === 1) {
        const start = path.indexOf(dep);
        return [...path.slice(start < 0 ? 0 : start), dep];
      }
      if (seen === undefined) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of byId.keys()) {
    if (state.get(id) === undefined) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Topological parallelism levels: level 0 has no dependencies, level n depends only on earlier levels. */
function levelsOf(tasks: readonly CollaborateTask[]): string[][] {
  const remaining = new Map(tasks.map((task) => [task.id, task] as const));
  const done = new Set<string>();
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const level = [...remaining.values()].filter((task) => task.dependsOn.every((dep) => done.has(dep)));
    if (level.length === 0) break; // unreachable: acyclicity is proven before this runs
    levels.push(level.map((task) => task.id));
    for (const task of level) {
      remaining.delete(task.id);
      done.add(task.id);
    }
  }
  return levels;
}

export function validateCollaboratePlan(raw: unknown, slotNames: readonly string[]): CollaborateValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["plan must be a JSON object with a tasks array"] };
  }
  const rawTasks = (raw as Record<string, unknown>).tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return { ok: false, errors: ["plan.tasks must be a non-empty array"] };
  }
  const errors: string[] = [];
  const known = new Set(slotNames);
  const tasks: CollaborateTask[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawTasks.length; i++) {
    const label = `tasks[${i}]`;
    const entry = rawTasks[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const value = entry as Record<string, unknown>;
    const id = asString(value.id);
    if (id === "") errors.push(`${label}.id must be a non-empty string`);
    else if (seenIds.has(id)) errors.push(`${label}.id duplicates task "${id}"`);
    seenIds.add(id);
    const assignee = asString(value.assignee);
    if (!known.has(assignee)) {
      errors.push(`${label}.assignee "${assignee}" is not one of the slots: ${slotNames.join(", ") || "(none)"}`);
    }
    const deps = value.dependsOn === undefined ? { list: [] as string[], valid: true } : stringList(value.dependsOn);
    if (!deps.valid) errors.push(`${label}.dependsOn must be an array of task ids`);
    const files = stringList(value.files);
    if (!files.valid || files.list.length === 0) errors.push(`${label}.files must be a non-empty array of file paths`);
    const verify = asString(value.verify);
    if (verify === "") errors.push(`${label}.verify must be a non-empty command string`);
    if (id !== "") {
      tasks.push({ id, assignee, dependsOn: deps.list, files: files.list, verify, description: asString(value.description) });
    }
  }

  const byId = new Map<string, CollaborateTask>();
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task);
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) errors.push(`task "${task.id}" depends on itself`);
      else if (!byId.has(dep)) errors.push(`task "${task.id}" depends on unknown task "${dep}"`);
    }
  }
  for (const name of slotNames) {
    if (!tasks.some((task) => task.assignee === name)) errors.push(`slot "${name}" has no assigned task`);
  }
  const cycle = findCycle(byId);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { tasks, levels: levelsOf(tasks) } };
}

function cell(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function renderMarkdown(plan: CollaboratePlan, author: string): string {
  return [
    `### Delegation plan — ${plural(plan.tasks.length, "task")} · ${plural(plan.levels.length, "dependency level")} · proposed by [${author}]`,
    "",
    "| task | owner | depends on | files | verify |",
    "|---|---|---|---|---|",
    ...plan.tasks.map(
      (task) =>
        `| ${cell(task.id)} | ${cell(task.assignee)} | ${cell(task.dependsOn.join(", ")) || "—"} | ${cell(task.files.join(", "))} | ${cell(task.verify)} |`,
    ),
    "",
    `Parallelism by level: ${plan.levels.map((ids, index) => `${index + 1}) ${ids.join(" ∥ ")}`).join("  →  ")}`,
    "",
    ...plan.tasks.map((task) => `- **${task.id}** (${task.assignee}) — ${cell(task.description)}`),
  ].join("\n");
}

/**
 * Picks the architect proposal — the first slot whose text parses AND validates. Fails closed:
 * when no slot produces a valid DAG the step FAILs with every validation error, never a plain
 * opinion fallback.
 */
export function mergeCollaborate(slots: SlotResult[]): StepResult {
  const slotNames = slots.map((slot) => slot.name);
  const issues: string[] = [];
  for (const slot of slots) {
    const result = validateCollaboratePlan(parseCollaboratePlan(slot.text), slotNames);
    if (result.ok) {
      return {
        verdict: "PASS",
        artifacts: {
          collaborate: renderMarkdown(result.plan, slot.name),
          "plan.json": `${JSON.stringify(result.plan, null, 2)}\n`,
        },
      };
    }
    for (const error of result.errors) issues.push(`[${slot.name}] ${error}`);
  }
  return { verdict: "FAIL", issues: issues.length > 0 ? issues : ["no slot produced a collaborate plan"] };
}
