import type { StageDef } from "./schema.js";

export const AGENTS = [
  "issue-analyst", "planner", "architect", "tester", "implementer", "reviewer",
  "security-auditor", "judge", "verifier", "root-cause-debugger", "discoverer",
  "codebase-cartographer", "codifier",
] as const;
export type AgentName = (typeof AGENTS)[number];

export const HOST_ACTIONS = [
  "scope-check", "checks", "publish", "escalate",
  "codify-mine", "codify-validate", "codify-publish", "codified-implement",
] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];

export const IMPLEMENT_CLASS_STAGES = ["implement", "fix"] as const;

export const PREDICATES = [
  "sections:", "red-baseline", "snapshot", "manifest", "manifest-record", "junit-green",
  "checks-green", "test-infra-restore", "flaky-rerun", "finalize", "citations",
  "verdict-consistent", "scope-report", "evidence-signed", "no-synthesized", "checklist",
  "ac-spotcheck", "head-is-judged-sha", "preflight", "deps-approval", "stuck-detector",
  "no-generated-docs",
  "evidence-signatures-verified", "candidates-schema", "candidates-nonempty", "assessment-schema",
  "rubric-hard", "oracles-select-observed-branches", "provenance-reproduces-members", "staged-layout",
  "header-template", "no-fixture-edits", "lint-clean", "skill-rendered", "dev-fixtures", "sealed-fixtures",
  "idempotent", "deterministic", "smoke-current-base", "matcher-overlap", "bindings-match-assessment",
  "deps-allowlist", "deps-locked", "no-hidden-unicode", "no-network-ast", "skill-injection-screen",
  "all-fixtures-pass", "manifest-sha-matches", "fusion-matches-lane", "artifact-sha-matches-judged",
] as const;

export const PARAMETERISED_PREDICATES = ["sections:", "snapshot:"] as const;

export const MODES = [
  "approach",
  "validate",
  "gate-writer",
  "gate-triage",
  "codified-diff",
  "refute",
  "fuse-synthesize",
  "grill",
  "assess",
  "generate",
  "repair",
  "codified",
  "approve-codify",
] as const;

export interface Catalog {
  agents: readonly string[];
  hostActions: readonly string[];
  predicates: readonly string[];
  parameterisedPredicates: readonly string[];
  modes: readonly string[];
  implementClassStages: readonly string[];
}

export const CATALOG: Catalog = {
  agents: AGENTS,
  hostActions: HOST_ACTIONS,
  predicates: PREDICATES,
  parameterisedPredicates: PARAMETERISED_PREDICATES,
  modes: MODES,
  implementClassStages: IMPLEMENT_CLASS_STAGES,
};

export function isAgent(value: string): value is AgentName {
  return (AGENTS as readonly string[]).includes(value);
}
export function isHostAction(value: string): value is HostAction {
  return (HOST_ACTIONS as readonly string[]).includes(value);
}
export function isImplementClassStage(value: string): boolean {
  return (IMPLEMENT_CLASS_STAGES as readonly string[]).includes(value);
}
export function isMode(value: string): boolean {
  return (MODES as readonly string[]).includes(value);
}

export function parsePredicate(gate: string): { id: string; arg?: string } {
  for (const prefix of PARAMETERISED_PREDICATES) {
    if (gate.startsWith(prefix) && gate.length > prefix.length) {
      return { id: prefix.slice(0, -1), arg: gate.slice(prefix.length) };
    }
  }
  return { id: gate };
}

export function isPredicate(gate: string): boolean {
  if ((PREDICATES as readonly string[]).includes(gate)) return true;
  const { id, arg } = parsePredicate(gate);
  if (arg === undefined) return false;
  return (PREDICATES as readonly string[]).includes(id) || (PREDICATES as readonly string[]).includes(`${id}:`);
}

export function mostRecentImplementStage(
  stages: Pick<StageDef, "name">[],
  before?: string,
): string | undefined {
  const end = before === undefined ? stages.length : stages.findIndex((s) => s.name === before);
  const last = end < 0 ? stages.length : end;
  for (let i = last - 1; i >= 0; i--) {
    const name = stages[i]?.name;
    if (name && isImplementClassStage(name)) return name;
  }
  return undefined;
}
