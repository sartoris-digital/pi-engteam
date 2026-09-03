import { isAgent, isHostAction, isImplementClassStage, isMode, isPredicate, type Catalog } from "./catalog.js";
import type { LaneDef, LaneMatch, NamedLane, StageDef } from "./schema.js";

export interface InvariantError {
  lane: string;
  stage?: string;
  rule: string;
  detail?: string;
}

export class LaneInvariantError extends Error {
  readonly errors: InvariantError[];
  constructor(errors: InvariantError[]) {
    super(errors.map((e) => `[${e.lane}${e.stage ? `/${e.stage}` : ""}] ${e.rule}`).join("; "));
    this.name = "LaneInvariantError";
    this.errors = errors;
  }
}

function err(lane: string, rule: string, stage?: string, detail?: string): InvariantError {
  return { lane, rule, ...(stage ? { stage } : {}), ...(detail ? { detail } : {}) };
}

function indexOf(stages: StageDef[], pred: (s: StageDef) => boolean): number {
  return stages.findIndex(pred);
}

export function checkCatalogInvariants(lane: NamedLane, catalog: Catalog): InvariantError[] {
  const out: InvariantError[] = [];
  for (const stage of lane.stages) {
    if (stage.agent && !catalog.agents.includes(stage.agent) && !isAgent(stage.agent)) {
      out.push(err(lane.name, "catalog-unknown-agent", stage.name, stage.agent));
    }
    if (stage.host && !catalog.hostActions.includes(stage.host) && !isHostAction(stage.host)) {
      out.push(err(lane.name, "catalog-unknown-host", stage.name, stage.host));
    }
    if (stage.mode && !isMode(stage.mode)) out.push(err(lane.name, "catalog-unknown-mode", stage.name, stage.mode));
    for (const gate of stage.gates ?? []) {
      if (!isPredicate(gate)) out.push(err(lane.name, "catalog-unknown-predicate", stage.name, gate));
    }
  }
  return out;
}

function checkBuild(lane: NamedLane): InvariantError[] {
  const out: InvariantError[] = [];
  const stages = lane.stages;
  const firstImpl = indexOf(stages, (s) => isImplementClassStage(s.name));
  const steer = indexOf(stages, (s) => s.name === "steer" && s.human === true);
  if (steer < 0) out.push(err(lane.name, "steer-missing", "steer"));
  else if (firstImpl >= 0 && steer > firstImpl) out.push(err(lane.name, "steer-after-implement", "steer"));
  const judge = stages.find((s) => s.name === "judge");
  if (!judge || judge.safetyGating !== true) out.push(err(lane.name, "judge-missing", "judge"));
  const last = stages[stages.length - 1];
  if (!last || last.host !== "publish") out.push(err(lane.name, "publish-not-last", last?.name));
  const hasImplementer = stages.some((s) => s.agent === "implementer" || s.name === "implement");
  const gateIdx = indexOf(stages, (s) => s.name === "gate");
  if (hasImplementer && lane.gateless !== true) {
    if (gateIdx < 0) out.push(err(lane.name, "gate-missing", "gate"));
  }
  if (gateIdx >= 0) {
    const gate = stages[gateIdx]!;
    const hasRed = (gate.gates ?? []).some((g) => g === "red-baseline" || g.startsWith("red-baseline:"));
    if (!hasRed) out.push(err(lane.name, "red-baseline-missing", "gate"));
    if (firstImpl >= 0 && gateIdx > firstImpl) out.push(err(lane.name, "gate-missing", "gate"));
  }
  if (lane.name === "chore" || lane.match.kind === "chore") {
    const first = stages[0];
    if (!first || first.host !== "scope-check") out.push(err(lane.name, "scope-check-first", first?.name ?? "scope-check"));
  }
  return out;
}

function checkPreBuild(lane: NamedLane): InvariantError[] {
  const out: InvariantError[] = [];
  if (lane.stages.some((s) => isImplementClassStage(s.name) || s.agent === "implementer")) {
    out.push(err(lane.name, "prebuild-has-implement"));
  }
  if (lane.stages.some((s) => s.host === "publish")) out.push(err(lane.name, "prebuild-has-publish"));
  const last = lane.stages[lane.stages.length - 1];
  if (!last || last.human !== true) out.push(err(lane.name, "prebuild-handoff-last", last?.name));
  return out;
}

const META_OK_AGENTS = new Set(["codifier", "judge", "reviewer", "security-auditor"]);
const META_FUSION_STAGES = new Set(["assess", "review", "security"]);

function isMetaPublishHost(host: string | undefined): boolean {
  return host === "publish" || host === "codify-publish";
}

function checkMeta(lane: NamedLane): InvariantError[] {
  const out: InvariantError[] = [];
  if (lane.stages.some((s) => s.human === true)) out.push(err(lane.name, "meta-has-human"));
  if (lane.stages.some((s) => isImplementClassStage(s.name) || s.agent === "implementer")) out.push(err(lane.name, "meta-has-implement"));
  if (lane.stages.some((s) => s.name === "gate")) out.push(err(lane.name, "meta-has-gate"));
  if (lane.stages.some((s) => s.name === "steer")) out.push(err(lane.name, "meta-has-steer"));
  const security = lane.stages.find((s) => s.name === "security");
  if (!security || security.when !== "true") out.push(err(lane.name, "meta-security-when", "security"));
  if (!security || security.locked !== true) out.push(err(lane.name, "meta-security-locked", "security"));
  const judge = lane.stages.find((s) => s.name === "judge");
  if (!judge || judge.safetyGating !== true) out.push(err(lane.name, "judge-missing", "judge"));
  if (!judge || judge.locked !== true) out.push(err(lane.name, "meta-judge-locked", "judge"));
  const validate = lane.stages.find((s) => s.name === "validate" || s.host === "codify-validate");
  if (!validate || validate.locked !== true || validate.host !== "codify-validate") {
    out.push(err(lane.name, "meta-validate-locked", "validate"));
  }
  const last = lane.stages[lane.stages.length - 1];
  if (!last || !isMetaPublishHost(last.host)) out.push(err(lane.name, "publish-not-last", last?.name));
  if (last && isMetaPublishHost(last.host) && last.locked !== true) {
    out.push(err(lane.name, "meta-publish-locked", last.name));
  }
  for (const stage of lane.stages) {
    if (stage.agent && !META_OK_AGENTS.has(stage.agent)) {
      out.push(err(lane.name, "meta-codifier-only-writer", stage.name, stage.agent));
    }
    if (stage.fusion && !META_FUSION_STAGES.has(stage.name)) {
      out.push(err(lane.name, "meta-fusion-scope", stage.name));
    }
  }
  return out;
}

export function checkInvariants(lane: NamedLane, catalog: Catalog): InvariantError[] {
  const cls = lane.class ?? "build";
  const classErrors =
    cls === "pre-build" ? checkPreBuild(lane) : cls === "meta" ? checkMeta(lane) : checkBuild(lane);
  return [...classErrors, ...checkCatalogInvariants(lane, catalog)];
}

function listOverlap(a?: string[], b?: string[]): boolean {
  if (!a || a.length === 0 || !b || b.length === 0) return true;
  return a.some((x) => b.includes(x));
}

export function matchesOverlap(a: LaneMatch, b: LaneMatch): boolean {
  const same = (x?: string, y?: string): boolean => x === undefined || y === undefined || x === y;
  return (
    same(a.kind, b.kind) &&
    same(a.tier, b.tier) &&
    same(a.size, b.size) &&
    listOverlap(a.labels, b.labels) &&
    listOverlap(a.flags, b.flags) &&
    listOverlap(a.trigger, b.trigger)
  );
}

function isAlways(when?: string): boolean {
  return when === undefined || when.trim() === "" || when.trim() === "true";
}

export function checkOverrideInvariants(
  builtins: Record<string, LaneDef>,
  effective: Record<string, LaneDef>,
  _catalog: Catalog,
): InvariantError[] {
  const out: InvariantError[] = [];
  for (const [name, base] of Object.entries(builtins)) {
    const next = effective[name];
    if (!next) continue;
    const locked = base.stages.filter((s) => s.locked === true);
    const lockedNames = locked.map((s) => s.name);
    const positions = lockedNames.map((n) => next.stages.findIndex((s) => s.name === n));
    lockedNames.forEach((stage, i) => {
      if ((positions[i] ?? -1) < 0) out.push(err(name, "locked-removed", stage));
    });
    const present = positions.filter((p) => p >= 0);
    if (present.some((p, i) => i > 0 && p < (present[i - 1] ?? 0))) {
      out.push(err(name, "locked-reordered"));
    }
    for (const stage of base.stages) {
      const got = next.stages.find((s) => s.name === stage.name);
      if (!got) continue;
      const need = new Set(stage.gates ?? []);
      const have = new Set(got.gates ?? []);
      for (const g of need) {
        if (!have.has(g)) out.push(err(name, "gates-removed", stage.name, g));
      }
    }
    const b = base.budget;
    const e = next.budget;
    if (e.fixRounds > b.fixRounds || e.maxWallSeconds > b.maxWallSeconds || e.maxCostUsd > b.maxCostUsd) {
      out.push(err(name, "budget-loosened"));
    }
    const baseByName = new Map(base.stages.map((s) => [s.name, s]));
    for (const stage of next.stages) {
      const prev = baseByName.get(stage.name);
      if (!prev) continue;
      if (isAlways(prev.when) && !isAlways(stage.when)) out.push(err(name, "when-loosened", stage.name));
    }
  }
  for (const [name, lane] of Object.entries(effective)) {
    if ((lane.class ?? "build") !== "meta") continue;
    const base = builtins[name];
    if (!base || (base.class ?? "build") !== "meta") {
      out.push(err(name, "meta-added-by-repo"));
    }
  }
  const names = Object.keys(effective);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = effective[names[i]!]!;
      const b = effective[names[j]!]!;
      if (a.priority === b.priority && matchesOverlap(a.match, b.match)) {
        out.push(err(names[i]!, "match-overlap", undefined, names[j]));
      }
    }
  }
  return out;
}

export function checkAllInvariants(
  builtins: Record<string, LaneDef>,
  effective: Record<string, LaneDef>,
  catalog: Catalog,
): InvariantError[] {
  const out: InvariantError[] = [];
  for (const [name, lane] of Object.entries(effective)) {
    out.push(...checkInvariants({ ...lane, name }, catalog));
  }
  out.push(...checkOverrideInvariants(builtins, effective, catalog));
  return out;
}
