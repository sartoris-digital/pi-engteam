// Phase 5.6 §9.2: Pi TUI footer widget. Renders a compact two-column
// status string for the Pi TUI's setStatus("tilldone", text) channel.
//
// Layout (single-line for setStatus; multi-line variant available for
// run-status output):
//   <workflow>: <goal-short> [done/total] · <team-summary>
// Where team-summary is "ENG 1/3 · VAL 0/2 · INV 0/1" etc, capped to keep
// the line readable.

import type { Task } from "../team/tools/TaskList.js";

const SHORT: Record<string, string> = {
  engineering: "ENG",
  validation: "VAL",
  investigation: "INV",
  planning: "PLN",
  "cross-functional": "CFN",
};

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function formatTillDoneFooter(opts: {
  workflow: string;
  goal: string;
  tasks: Task[];
}): string {
  const { workflow, goal, tasks } = opts;
  const total = tasks.length;
  if (total === 0) {
    return `${workflow} · ${clip(goal, 60)}`;
  }
  const completed = tasks.filter((t) => t.status === "completed").length;
  // Group by team (or "?" for unassigned).
  const buckets = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    const key = t.team ?? "?";
    const bucket = buckets.get(key) ?? { done: 0, total: 0 };
    bucket.total++;
    if (t.status === "completed") bucket.done++;
    buckets.set(key, bucket);
  }
  // Render in a stable order: planning, engineering, validation, investigation, cross-functional, unassigned.
  const order = ["planning", "engineering", "validation", "investigation", "cross-functional", "?"];
  const parts: string[] = [];
  for (const key of order) {
    const b = buckets.get(key);
    if (!b) continue;
    const label = SHORT[key] ?? "UNA";
    parts.push(`${label} ${b.done}/${b.total}`);
  }
  const teamSummary = parts.join(" · ");
  return `${workflow} · ${clip(goal, 40)} [${completed}/${total}]${teamSummary ? " · " + teamSummary : ""}`;
}

/**
 * Multi-line variant for /run-status — readable detailed listing rather
 * than the cramped TUI footer. Lists each task with its team + status.
 */
export function formatTillDoneDetailed(opts: {
  workflow: string;
  goal: string;
  tasks: Task[];
}): string {
  const { workflow, goal, tasks } = opts;
  if (tasks.length === 0) {
    return `${workflow} — ${goal}\n(no tasks)`;
  }
  const completed = tasks.filter((t) => t.status === "completed").length;
  const lines: string[] = [];
  lines.push(`${workflow} — ${goal}`);
  lines.push(`Tasks: ${completed}/${tasks.length} complete`);
  lines.push("");
  // Group by team.
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.team ?? "unassigned";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const order = ["planning", "engineering", "validation", "investigation", "cross-functional", "unassigned"];
  for (const key of order) {
    const group = groups.get(key);
    if (!group) continue;
    lines.push(`[${key}]`);
    for (const t of group) {
      const marker =
        t.status === "completed" ? "✓" :
        t.status === "in_progress" ? "●" :
        t.status === "blocked" ? "✗" :
        "○";
      lines.push(`  ${marker} ${t.taskId}${t.notes ? "  — " + clip(t.notes, 60) : ""}`);
    }
  }
  return lines.join("\n");
}
