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

// Round-1 L2: final cap on the rendered status line so a long workflow
// name + many teams + huge digit counts can't overflow the Pi TUI bar.
const MAX_STATUS_LINE = 200;
const GOAL_CLIP = 40;

// Round-1 M1 + round-2 L1 + round-3 L1: scrub ASCII control chars
// (0x00-0x1F + 0x7F DEL) AND Unicode visual controls (line/paragraph
// separators, BiDi controls, zero-width chars) from worker-controlled
// fields.
//
// Built with `new RegExp(...)` because U+2028/U+2029 (LINE/PARAGRAPH
// SEPARATOR) cannot appear inside a JS regex literal — they terminate
// the literal and break parsing. The string-based constructor with the
// `u` flag accepts \u{XXXX} escapes for arbitrary code points.
//
// Coverage rationale:
//   - 0x00-0x1F + 0x7F      — ASCII control + DEL
//   - U+200B / U+FEFF       — ZERO-WIDTH SPACE / BOM (invisible padding)
//   - U+200E / U+200F       — LRM / RLM
//   - U+202A-U+202E         — embedding overrides
//   - U+2028 / U+2029       — LINE / PARAGRAPH SEPARATOR (split lines)
//   - U+2066-U+2069         — isolate controls (BiDi reorder attacks)
const CONTROL_RE = new RegExp(
  "[\\x00-\\x1F\\x7F" +
    "\\u{200B}\\u{200E}\\u{200F}\\u{202A}-\\u{202E}" +
    "\\u{2028}\\u{2029}\\u{2066}-\\u{2069}\\u{FEFF}]",
  "gu",
);
function sanitize(s: string): string {
  return s.replace(CONTROL_RE, " ");
}

export function formatTillDoneFooter(opts: {
  workflow: string;
  goal: string;
  tasks: Task[];
}): string {
  const { workflow, goal, tasks } = opts;
  const total = tasks.length;
  // Round-1 L1: same 40-char goal clip in the empty-tasks fallback as in
  // the populated path — spec §9.2 says 40, was inconsistently 60 here.
  if (total === 0) {
    return clip(`${workflow} · ${clip(goal, GOAL_CLIP)}`, MAX_STATUS_LINE);
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
  const rendered = `${workflow} · ${clip(goal, GOAL_CLIP)} [${completed}/${total}]${teamSummary ? " · " + teamSummary : ""}`;
  return clip(rendered, MAX_STATUS_LINE);
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
      // Round-1 M1: sanitize notes/taskId before rendering. notes is
      // worker-controlled and could otherwise inject newlines or ANSI
      // escapes into the multi-line /run-status block.
      const noteSnippet = t.notes ? "  — " + clip(sanitize(t.notes), 60) : "";
      lines.push(`  ${marker} ${sanitize(t.taskId)}${noteSnippet}`);
    }
  }
  return lines.join("\n");
}
