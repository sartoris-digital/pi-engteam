import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveRepoConfig } from "../config/schema.js";
import type { EvidenceRecord } from "../engine/evidence.js";
import type { RunState, Step, StepContext, StepResult, Verdict } from "../engine/types.js";
import { isSteerAction, type SteerAction, type SteerDecision } from "./dialog.js";
import { writeHumanInput } from "./human-input.js";
import { composeSteerPacket } from "./packet.js";

export type SteeringPolicy = EffectiveRepoConfig["steering"];
export type SteerMode = "pause" | "auto";
export type PolicyResolver = (ctx: StepContext) => SteeringPolicy;

export const configPolicyResolver: PolicyResolver = (ctx) => ctx.cfg.steering;

/** Spec §4.10 policy: always pauses; elevated pauses only on an elevated tier; never auto-approves. */
export function resolveSteerMode(policy: SteeringPolicy, tier: RunState["tier"]): SteerMode {
  switch (policy) {
    case "always":
      return "pause";
    case "elevated":
      return tier === "elevated" ? "pause" : "auto";
    case "never":
      return "auto";
  }
}

export interface RehashResult {
  ok: boolean;
  note: string;
}

export interface SteerHooks {
  /** Persist a signed evidence record; returns the evidence file path. */
  writeEvidence: (runDir: string, record: EvidenceRecord) => Promise<string>;
  /** edit-approve: re-verify the RED baseline and re-hash the test manifest (v0 controller: no-op ok). */
  rehash: (ctx: StepContext) => Promise<RehashResult>;
  now?: () => Date;
}

export interface SteerDecisionFile {
  schemaVersion: 1;
  action: SteerAction;
  notes?: string;
  waive?: string[];
  decidedAt: string;
  by: "tui" | "command";
}

interface SteerAutoEntry {
  schemaVersion: 1;
  action: "auto";
  policy: SteeringPolicy;
  tier: RunState["tier"];
  decidedAt: string;
  by: "auto";
}

export const STEER_DECISION_FILE = "steer-decision.json";

/** The one live decision path. Only writeSteerDecision writes here; only this step reads it. */
export function steerDecisionPath(runDir: string): string {
  return join(runDir, STEER_DECISION_FILE);
}

/** Archive of consumed decisions: steer-<n>.json, the path Task 9.15 asserts. */
export function steerDecisionsDir(runDir: string): string {
  return join(runDir, "steer-decisions");
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Single entry point for persisting an operator decision. `/factory approve`
 * and the TUI wiring call this BEFORE engine.resumeRun; the engine writes no
 * decision file of its own.
 */
export async function writeSteerDecision(
  runDir: string,
  decision: SteerDecision,
  by: "tui" | "command" = "command",
  now: () => Date = () => new Date(),
): Promise<string> {
  if (decision.action === "pending") throw new Error("cannot persist a pending steer decision");
  const file: SteerDecisionFile = { schemaVersion: 1, action: decision.action, decidedAt: now().toISOString(), by };
  if (decision.notes !== undefined && decision.notes.trim().length > 0) file.notes = decision.notes;
  if (decision.waive !== undefined && decision.waive.length > 0) file.waive = decision.waive;
  await mkdir(runDir, { recursive: true });
  const path = steerDecisionPath(runDir);
  await writeJsonAtomic(path, file);
  return path;
}

export async function readSteerDecision(path: string): Promise<SteerDecisionFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid steer decision in ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error(`invalid steer decision in ${path}: not an object`);
  const d = parsed as Record<string, unknown>;
  if (!isSteerAction(d.action)) {
    throw new Error(`invalid steer decision in ${path}: unknown action ${JSON.stringify(d.action)}`);
  }
  if (d.notes !== undefined && typeof d.notes !== "string") {
    throw new Error(`invalid steer decision in ${path}: notes must be a string`);
  }
  if (d.waive !== undefined && (!Array.isArray(d.waive) || d.waive.some((w) => typeof w !== "string"))) {
    throw new Error(`invalid steer decision in ${path}: waive must be a string array`);
  }
  const file: SteerDecisionFile = {
    schemaVersion: 1,
    action: d.action,
    decidedAt: typeof d.decidedAt === "string" ? d.decidedAt : "",
    by: d.by === "tui" ? "tui" : "command",
  };
  if (typeof d.notes === "string") file.notes = d.notes;
  if (Array.isArray(d.waive)) file.waive = d.waive as string[];
  return file;
}

/** 1 + number of archived steer passes (decisions and AUTO entries alike). */
async function nextSteerIndex(runDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(steerDecisionsDir(runDir));
  } catch (err) {
    if (isEnoent(err)) return 1;
    throw err;
  }
  return names.filter((name) => /^steer-\d+\.json$/.test(name)).length + 1;
}

async function archiveDecision(runDir: string, fromPath: string, n: number): Promise<string> {
  await mkdir(steerDecisionsDir(runDir), { recursive: true });
  const to = join(steerDecisionsDir(runDir), `steer-${n}.json`);
  await rename(fromPath, to);
  return to;
}

function evidenceFor(
  ctx: StepContext,
  round: number,
  verdict: Verdict | "AUTO",
  predicates: EvidenceRecord["predicates"],
  humanTurns: number,
  now: () => Date,
): EvidenceRecord {
  const record: EvidenceRecord = {
    stage: "steer",
    round,
    agent: "human",
    verdict,
    predicates,
    artifacts: [],
    commands: [],
    synthesized: [],
    timedOut: false,
    headSha: ctx.state.hostCommits[ctx.state.hostCommits.length - 1] ?? ctx.state.baseSha,
    at: now().toISOString(),
  };
  if (humanTurns > 0) record.humanIntervened = { turns: humanTurns };
  return record;
}

async function applyDecision(
  ctx: StepContext,
  decision: SteerDecisionFile,
  decisionPath: string,
  n: number,
  hooks: SteerHooks,
  now: () => Date,
): Promise<StepResult> {
  const { runDir } = ctx;
  const archived = await archiveDecision(runDir, decisionPath, n);
  const artifacts: Record<string, string> = { [`steer-decision-${n}`]: archived };
  const decided = { name: "steer-decision", ok: true, note: decision.action };

  const notes = decision.notes?.trim() ?? "";
  if (notes.length > 0 && (decision.action === "steer" || decision.action === "replan")) {
    artifacts.humanInput = await writeHumanInput(runDir, n, notes, ctx.nonce);
  }

  const finish = async (
    verdict: Verdict,
    predicates: EvidenceRecord["predicates"],
    rest: Pick<StepResult, "issues" | "escalate">,
  ): Promise<StepResult> => {
    artifacts["steer-evidence"] = await hooks.writeEvidence(runDir, evidenceFor(ctx, n, verdict, predicates, 1, now));
    return { verdict, artifacts, evidence: { verdict, predicates }, ...rest };
  };

  switch (decision.action) {
    case "approve":
    case "steer":
      return finish("PASS", [decided], {});
    case "replan":
      return finish("NEEDS_MORE", [decided], { issues: ["replan"] });
    case "edit-approve": {
      const rehash = await hooks.rehash(ctx);
      const predicates = [decided, { name: "steer-edit-rehash", ok: rehash.ok, note: rehash.note }];
      return rehash.ok
        ? finish("PASS", predicates, {})
        : finish("FAIL", predicates, { issues: [rehash.note], escalate: "gate-invalid" });
    }
    case "drop":
      return finish("FAIL", [decided], { issues: ["dropped at steer by operator"], escalate: "needs-decision" });
  }
}

/**
 * The locked `steer` stage (spec §4.4, §4.10). First pass: compose the packet
 * and either pause (pauseForUser) or auto-approve with `steer: auto` evidence.
 * Resumed pass: consume <runDir>/steer-decision.json — written by
 * writeSteerDecision from `/factory approve` or the TUI wiring, never by the
 * engine — and act on it, archiving it under steer-decisions/steer-<n>.json.
 */
export function makeSteerStep(policyResolver: PolicyResolver, hooks: SteerHooks): Step {
  const now = hooks.now ?? (() => new Date());
  return {
    name: "steer",
    kind: "human",
    gates: [],
    onFail: "escalate:needs-decision",
    locked: true,
    run: async (ctx: StepContext): Promise<StepResult> => {
      const { runDir, state } = ctx;
      const n = await nextSteerIndex(runDir);

      const decisionPath = state.artifacts["steer-decision"] ?? steerDecisionPath(runDir);
      const decision = await readSteerDecision(decisionPath);
      if (decision !== null) return applyDecision(ctx, decision, decisionPath, n, hooks, now);

      const packet = await composeSteerPacket(state, runDir, ctx.cfg, { now });
      const artifacts: Record<string, string> = {
        "steer-packet": packet.markdownPath,
        "steer-packet-json": packet.jsonPath,
      };
      const policy = policyResolver(ctx);
      if (resolveSteerMode(policy, state.tier) === "pause") {
        return { verdict: "PASS", artifacts, pauseForUser: { reason: "steer", packetPath: packet.markdownPath } };
      }

      const entry: SteerAutoEntry = {
        schemaVersion: 1,
        action: "auto",
        policy,
        tier: state.tier,
        decidedAt: now().toISOString(),
        by: "auto",
      };
      await mkdir(steerDecisionsDir(runDir), { recursive: true });
      await writeJsonAtomic(join(steerDecisionsDir(runDir), `steer-${n}.json`), entry);

      const record = evidenceFor(
        ctx,
        n,
        "AUTO",
        [{ name: "steer-policy", ok: true, note: `auto-approved: steering=${policy}, tier=${state.tier}` }],
        0,
        now,
      );
      artifacts["steer-evidence"] = await hooks.writeEvidence(runDir, record);
      return { verdict: "PASS", artifacts, evidence: { verdict: "AUTO", predicates: record.predicates } };
    },
  };
}
