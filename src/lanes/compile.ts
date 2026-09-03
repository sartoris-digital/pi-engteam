import { createHash } from "node:crypto";
import { canonicalJson } from "../config/json.js";
import { computeIterationBudget } from "../engine/budget.js";
import type { Step, StepResult, Transition, Workflow } from "../engine/types.js";
import {
  isAgent,
  isHostAction,
  isImplementClassStage,
  isMode,
  isPredicate,
  mostRecentImplementStage,
  type Catalog,
} from "./catalog.js";
import type { StageHooks } from "./hooks.js";
import type { NamedLane, StageDef } from "./schema.js";

export const DEFAULT_STAGE_TIMEOUT_SECONDS = 1800;

export class CompileError extends Error {
  readonly lane: string;
  readonly stage: string | undefined;
  constructor(message: string, lane: string, stage?: string) {
    super(message);
    this.name = "CompileError";
    this.lane = lane;
    this.stage = stage;
  }
}

export interface CompileOptions {
  timeoutSeconds?: number;
}

const DIGEST_KEYS = ["name", "class", "match", "priority", "budget", "stages", "publish", "gateless", "onExhausted"] as const;

export function laneSha8(lane: NamedLane): string {
  const payload: Record<string, unknown> = {};
  for (const key of DIGEST_KEYS) payload[key] = lane[key];
  return createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 8);
}

export function workflowName(lane: NamedLane): string {
  return `factory-sdlc:${lane.name}@${laneSha8(lane)}`;
}

function stageKind(def: StageDef): "agent" | "host" | "human" {
  if (def.human === true) return "human";
  if (def.host) return "host";
  return "agent";
}

function defaultOnFail(kind: "agent" | "host" | "human"): Step["onFail"] {
  return kind === "host" ? "continue" : "escalate:needs-decision";
}

function assertCatalog(lane: string, def: StageDef, catalog: Catalog): void {
  if (def.agent && !catalog.agents.includes(def.agent) && !isAgent(def.agent)) {
    throw new CompileError(`unknown agent ${def.agent}`, lane, def.name);
  }
  if (def.host && !catalog.hostActions.includes(def.host) && !isHostAction(def.host)) {
    throw new CompileError(`unknown host action ${def.host}`, lane, def.name);
  }
  if (def.mode && !isMode(def.mode)) throw new CompileError(`unknown mode ${def.mode}`, lane, def.name);
  for (const gate of def.gates ?? []) {
    if (!isPredicate(gate)) throw new CompileError(`unknown predicate ${gate}`, lane, def.name);
  }
  if (def.fusion && (isImplementClassStage(def.name) || Boolean(def.host))) {
    throw new CompileError(`fusion is not allowed on implement-class or host stages`, lane, def.name);
  }
}

function toStep(def: StageDef, hooks: StageHooks, timeout: number, lane: string, catalog: Catalog): Step {
  assertCatalog(lane, def, catalog);
  const kind = stageKind(def);
  const run =
    kind === "agent" ? hooks.agentStep(def, def.name) : kind === "host" ? hooks.hostStep(def, def.name) : hooks.humanStep(def, def.name);
  return {
    name: def.name,
    kind,
    ...(def.agent ? { agent: def.agent } : {}),
    ...(def.host ? { host: def.host } : {}),
    ...(def.mode ? { mode: def.mode } : {}),
    ...(def.when ? { when: def.when } : {}),
    gates: def.gates ?? [],
    onFail: (def.onFail as Step["onFail"] | undefined) ?? defaultOnFail(kind),
    ...(def.maxRounds !== undefined ? { maxRounds: def.maxRounds } : {}),
    ...(def.locked !== undefined ? { locked: def.locked } : {}),
    ...(def.safetyGating !== undefined ? { safetyGating: def.safetyGating } : {}),
    ...(def.verify !== undefined ? { verify: def.verify } : {}),
    timeoutSeconds: def.timeoutSeconds ?? timeout,
    run,
  };
}

function generateTransitions(steps: Step[]): Transition[] {
  const active = steps.filter((s) => !(s.kind === "host" && s.host === "escalate"));
  const out: Transition[] = [];
  const names = active.map((s) => s.name);
  active.forEach((step, i) => {
    const next = names[i + 1] ?? "halt";
    out.push({ from: step.name, when: (r: StepResult) => r.verdict === "PASS", to: next });
    if (step.onFail === "fix-round") {
      // FAIL on implement-class retries itself; FAIL later in the cycle jumps to the most recent implement-class stage.
      const back = isImplementClassStage(step.name)
        ? step.name
        : (mostRecentImplementStage(active, step.name) ?? "escalate");
      out.push({ from: step.name, when: (r: StepResult) => r.verdict !== "PASS", to: back });
    } else if (step.onFail === "continue") {
      out.push({ from: step.name, when: (r: StepResult) => r.verdict !== "PASS", to: next });
    } else {
      out.push({ from: step.name, when: (r: StepResult) => r.verdict !== "PASS", to: "escalate" });
    }
  });
  return out;
}

export function compileLane(lane: NamedLane, catalog: Catalog, hooks: StageHooks, opts: CompileOptions = {}): Workflow {
  const timeout = opts.timeoutSeconds ?? DEFAULT_STAGE_TIMEOUT_SECONDS;
  const yamlSteps = lane.stages.map((s) => toStep(s, hooks, timeout, lane.name, catalog));
  if (!yamlSteps.some((s) => s.kind === "host" && s.host === "escalate")) {
    yamlSteps.push(
      toStep({ name: "escalate", host: "escalate" }, hooks, timeout, lane.name, catalog),
    );
  }
  const transitions = generateTransitions(yamlSteps);
  const workflow: Workflow = {
    name: workflowName(lane),
    lane: lane.name,
    laneClass: lane.class ?? "build",
    steps: yamlSteps,
    transitions,
    budget: { ...lane.budget, maxIterations: 0 },
  };
  workflow.budget.maxIterations = computeIterationBudget(workflow);
  return workflow;
}
