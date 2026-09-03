import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { EffectiveRepoConfig } from "../config/schema.js";
import { writeGeneratedJson } from "../engine/state.js";
import type { RunState } from "../engine/types.js";
import { applicableRules } from "../rules/prompt.js";
import type { RuleRecord } from "../rules/schema.js";

/** The one host-written facts file a worker's AskHost tool reads. */
export const STAGE_FACTS_FILE = "facts.json";

/**
 * A vault reference in any layered config value. facts.json is an allowlist of host-owned,
 * non-secret fields, so nothing here should ever match; the scrub is the second lock.
 */
const SECRET_REF_RE = /\bsecret:\S*/gi;

export interface StageFactRule {
  id: string;
  text: string;
}

/**
 * Everything the host already knows and a worker would otherwise guess at. Allowlist only:
 * no vault values, no `secret:` references, no provider keys or tokens, no remote URLs and no
 * raw ticket text — checks appear by name, never by argv.
 */
export interface StageFacts {
  lane: string;
  stage: string;
  kind: RunState["kind"];
  tier: RunState["tier"];
  ticketRef: string;
  branching: { base: string; target: string };
  testDir: string;
  testPattern: string;
  /** The write roots for THIS run's kind, not the whole table. */
  writeRoots: string[];
  /** Check names only. */
  checks: string[];
  maxDiffLines: number;
  maxChangedFiles: number;
  rules: StageFactRule[];
}

export interface BuildStageFactsInput {
  state: RunState;
  cfg: EffectiveRepoConfig;
  stage: string;
  rules?: RuleRecord[];
}

export function stageFactsPath(runDir: string): string {
  return join(runDir, STAGE_FACTS_FILE);
}

function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return value.replace(SECRET_REF_RE, "[redacted]") as unknown as T;
  if (Array.isArray(value)) return value.map((item: unknown) => scrubDeep(item)) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out as unknown as T;
  }
  return value;
}

export function buildStageFacts({ state, cfg, stage, rules }: BuildStageFactsInput): StageFacts {
  const facts: StageFacts = {
    lane: state.lane,
    stage,
    kind: state.kind,
    tier: state.tier,
    ticketRef: state.ticket.ref,
    branching: { base: cfg.branching.base, target: cfg.branching.target },
    testDir: cfg.testDir,
    testPattern: cfg.testPattern,
    writeRoots: [...(cfg.writeRoots[state.kind] ?? [])],
    checks: cfg.checks.map((c) => c.name),
    maxDiffLines: cfg.maxDiffLines,
    maxChangedFiles: cfg.maxChangedFiles,
    rules: applicableRules(rules ?? [], stage, state.kind).map((r) => ({ id: r.id, text: r.text })),
  };
  return scrubDeep(facts);
}

/** Writes <runDir>/facts.json 0600 with the generated marker as its first line. */
export async function writeStageFacts(runDir: string, facts: StageFacts): Promise<string> {
  const path = stageFactsPath(runDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeGeneratedJson(path, basename(runDir), facts, 0o600);
  return path;
}
