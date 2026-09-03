import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveRepoConfig } from "../config/schema.js";
import type { RunState } from "../engine/types.js";
import { generatedMarker } from "../home.js";

export interface SteerAcceptanceCriterion {
  id: string;
  text: string;
  source: "quoted" | "derived" | "inferred";
}

export interface SteerPacketJson {
  generated: string;
  runId: string;
  composedAt: string;
  ticket: RunState["ticket"];
  classification: { kind: RunState["kind"]; tier: RunState["tier"]; lane: string; confidence: string | null };
  acceptanceCriteria: SteerAcceptanceCriterion[];
  plan: { present: boolean; path: string | null; summary: string };
  redTests: string[];
  filesToTouch: string[];
  budget: {
    fixRounds: number;
    maxWallSeconds: number;
    maxCostUsd: number;
    maxIterations: number;
    wallSecondsUsed: number;
    costUsd: number;
    steering: EffectiveRepoConfig["steering"];
  };
  openQuestions: string[];
}

export interface SteerPacket {
  markdown: string;
  json: SteerPacketJson;
  markdownPath: string;
  jsonPath: string;
}

export function steerPacketPaths(runDir: string): { markdownPath: string; jsonPath: string } {
  return { markdownPath: join(runDir, "steer-packet.md"), jsonPath: join(runDir, "steer-packet.json") };
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Body of the markdown section titled `heading` (any level, case-insensitive) up to the next heading. */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const re = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "i");
  const start = lines.findIndex((line) => re.test(line.trim()));
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^#{1,6}\s+/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

/** Bullet / numbered items of a section, with wrapping backticks removed. */
export function listItems(section: string | null): string[] {
  if (section === null) return [];
  const items: string[] = [];
  for (const raw of section.split("\n")) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const item = (m[1] ?? "").replace(/^`(.*)`$/, "$1").trim();
    if (item.length > 0) items.push(item);
  }
  return items;
}

/** `AC<n>: text` lines are author-stated (quoted); `- [ ] text` checklist items are derived. */
export function extractAcLines(text: string): SteerAcceptanceCriterion[] {
  const out: SteerAcceptanceCriterion[] = [];
  let next = 1;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const ac = /^(AC(\d+))\s*:\s*(.+)$/.exec(line);
    if (ac) {
      out.push({ id: ac[1] ?? "", text: (ac[3] ?? "").trim(), source: "quoted" });
      next = Math.max(next, Number(ac[2] ?? "0") + 1);
      continue;
    }
    const box = /^[-*]\s*\[[ xX]\]\s+(.+)$/.exec(line);
    if (box) {
      out.push({ id: `AC${next}`, text: (box[1] ?? "").trim(), source: "derived" });
      next += 1;
    }
  }
  return out;
}

export function planSummary(plan: string): string {
  const goal = extractSection(plan, "Goal");
  if (goal !== null && goal.length > 0) return goal;
  const body = plan.split("\n").filter((line, i) => !(i === 0 && line.startsWith("<!--")));
  return body.slice(0, 30).join("\n").trim();
}

interface BriefSubset {
  acceptanceCriteria: SteerAcceptanceCriterion[];
  confidence: string | null;
  questions: string[];
  likelyPaths: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

async function readBrief(runDir: string): Promise<BriefSubset | null> {
  const raw = await readIfExists(join(runDir, "brief.json"));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const brief = parsed as Record<string, unknown>;
  const acceptanceCriteria: SteerAcceptanceCriterion[] = [];
  if (Array.isArray(brief.acceptanceCriteria)) {
    for (const item of brief.acceptanceCriteria) {
      if (typeof item !== "object" || item === null) continue;
      const ac = item as Record<string, unknown>;
      if (typeof ac.id !== "string" || typeof ac.text !== "string") continue;
      const source = ac.source === "quoted" || ac.source === "derived" ? ac.source : "inferred";
      acceptanceCriteria.push({ id: ac.id, text: ac.text, source });
    }
  }
  return {
    acceptanceCriteria,
    confidence: typeof brief.confidence === "string" ? brief.confidence : null,
    questions: stringArray(brief.questions),
    likelyPaths: stringArray(brief.likelyPaths),
  };
}

interface GateEvidence {
  round: number;
  artifacts: string[];
  redNote: string | null;
}

async function readLatestGateEvidence(runDir: string): Promise<GateEvidence | null> {
  let names: string[];
  try {
    names = await readdir(join(runDir, "evidence"));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  let best: { round: number; name: string } | null = null;
  for (const name of names) {
    const m = /^stage-gate-r(\d+)\.json$/.exec(name);
    if (!m) continue;
    const round = Number(m[1] ?? "0");
    if (best === null || round > best.round) best = { round, name };
  }
  if (best === null) return null;
  const parsed: unknown = JSON.parse(await readFile(join(runDir, "evidence", best.name), "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const artifacts: string[] = [];
  if (Array.isArray(record.artifacts)) {
    for (const a of record.artifacts) {
      if (typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).path === "string") {
        artifacts.push((a as Record<string, unknown>).path as string);
      }
    }
  }
  let redNote: string | null = null;
  if (Array.isArray(record.predicates)) {
    for (const p of record.predicates) {
      if (typeof p !== "object" || p === null) continue;
      const pred = p as Record<string, unknown>;
      if (pred.name === "red-baseline" && typeof pred.note === "string") redNote = pred.note;
    }
  }
  return { round: best.round, artifacts, redNote };
}

function renderMarkdown(json: SteerPacketJson, extra: { jsonPath: string; gate: GateEvidence | null }): string {
  const c = json.classification;
  const b = json.budget;
  const acLines =
    json.acceptanceCriteria.length > 0
      ? json.acceptanceCriteria.map((ac) => `- ${ac.id} (${ac.source}): ${ac.text}`)
      : ["none stated — the implementer works from the task text"];
  const planLines = json.plan.present
    ? [`Source: \`${json.plan.path}\``, "", json.plan.summary]
    : ["no plan.md in the run dir (lane has no plan stage)"];
  const redLines =
    extra.gate !== null && json.redTests.length > 0
      ? [
          `From gate evidence round ${extra.gate.round}${extra.gate.redNote ? ` — ${extra.gate.redNote}` : ""}:`,
          ...json.redTests.map((t) => `- ${t}`),
        ]
      : ["none (no gate evidence recorded — lane has no gate stage)"];
  const fileLines = json.filesToTouch.length > 0 ? json.filesToTouch.map((f) => `- ${f}`) : ["not declared"];
  const questionLines = json.openQuestions.length > 0 ? json.openQuestions.map((q) => `- ${q}`) : ["none"];

  return [
    json.generated,
    "",
    `# Steer packet · ${json.ticket.ref} · run ${json.runId}`,
    "",
    json.ticket.title,
    "",
    `Approve with \`/factory approve ${json.ticket.ref}\` (the dialog also offers Steer with notes, Re-plan with notes, Edit in worktree then approve, Drop). Machine-readable copy: \`${extra.jsonPath}\`.`,
    "",
    "## Classification",
    `- kind: ${c.kind}`,
    `- tier: ${c.tier}`,
    `- lane: ${c.lane}`,
    `- confidence: ${c.confidence ?? "n/a (no intake brief)"}`,
    "",
    "## Acceptance criteria",
    ...acLines,
    "",
    "## Plan",
    ...planLines,
    "",
    "## RED tests",
    ...redLines,
    "",
    "## Files to touch",
    ...fileLines,
    "",
    "## Budget",
    `- fix rounds: ${b.fixRounds}`,
    `- max wall: ${b.maxWallSeconds} s (used ${b.wallSecondsUsed} s)`,
    `- max cost: $${b.maxCostUsd.toFixed(2)} (used $${b.costUsd.toFixed(2)})`,
    `- max iterations: ${b.maxIterations}`,
    `- steering policy: ${b.steering}`,
    "",
    "## Open questions",
    ...questionLines,
    "",
  ].join("\n");
}

/**
 * Host-composed steering packet (spec §4.10). Reads whatever the run dir has
 * (brief.json | ticket.md | task.md, plan.md, gate evidence) and writes
 * <runDir>/steer-packet.md (marker first) and <runDir>/steer-packet.json.
 */
export async function composeSteerPacket(
  state: RunState,
  runDir: string,
  cfg: EffectiveRepoConfig,
  opts: { now?: () => Date } = {},
): Promise<SteerPacket> {
  const now = opts.now ?? (() => new Date());
  const { markdownPath, jsonPath } = steerPacketPaths(runDir);

  const brief = await readBrief(runDir);
  const taskText =
    brief !== null
      ? null
      : (await readIfExists(join(runDir, "ticket.md"))) ?? (await readIfExists(join(runDir, "task.md")));
  const planPath = join(runDir, "plan.md");
  const plan = await readIfExists(planPath);
  const gate = await readLatestGateEvidence(runDir);

  const acceptanceCriteria = brief !== null ? brief.acceptanceCriteria : taskText !== null ? extractAcLines(taskText) : [];
  const planFiles = plan !== null ? listItems(extractSection(plan, "Files to touch")) : [];
  const filesToTouch = planFiles.length > 0 ? planFiles : brief?.likelyPaths ?? [];
  const openQuestions = [
    ...(brief?.questions ?? []),
    ...(plan !== null ? listItems(extractSection(plan, "Open questions")) : []),
  ];

  const json: SteerPacketJson = {
    generated: generatedMarker(state.runId),
    runId: state.runId,
    composedAt: now().toISOString(),
    ticket: state.ticket,
    classification: { kind: state.kind, tier: state.tier, lane: state.lane, confidence: brief?.confidence ?? null },
    acceptanceCriteria,
    plan: { present: plan !== null, path: plan !== null ? planPath : null, summary: plan !== null ? planSummary(plan) : "" },
    redTests: gate?.artifacts ?? [],
    filesToTouch,
    budget: {
      fixRounds: state.budget.fixRounds,
      maxWallSeconds: state.budget.maxWallSeconds,
      maxCostUsd: state.budget.maxCostUsd,
      maxIterations: state.budget.maxIterations,
      wallSecondsUsed: state.wallSecondsUsed,
      costUsd: state.costUsd,
      steering: cfg.steering,
    },
    openQuestions,
  };
  const markdown = renderMarkdown(json, { jsonPath, gate });

  await mkdir(runDir, { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(jsonPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  return { markdown, json, markdownPath, jsonPath };
}
