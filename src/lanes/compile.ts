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
import { FUSION_MODES, isFusionMode, type FusionMode } from "../fusion/types.js";
import type { StageHooks } from "./hooks.js";
import type { NamedLane, StageDef, StageFusionSlot } from "./schema.js";

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
  /**
   * Slot names from the operator's configured fusion stack (`operator.fusion.stack`). When it is
   * non-empty, a stage may only name slots that exist in it. Omitted or empty means the stack is
   * unknown at compile time and slot names are left to the runner to resolve.
   */
  fusionSlots?: readonly string[];
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
}

/** Modes that compare slots against each other; running them with a single slot is a silent no-op. */
const MULTI_SLOT_FUSION_MODES: ReadonlySet<FusionMode> = new Set<FusionMode>([
  "fuse",
  "debate",
  "adversarial",
  "veto",
  "collaborate",
]);

function slotName(entry: StageFusionSlot): string {
  return typeof entry === "string" ? entry : entry.name;
}

/** An entry without its own `model` is looked up in the configured stack by `parseSlots`. */
function resolvesFromStack(entry: StageFusionSlot): boolean {
  return typeof entry === "string" || entry.model === undefined;
}

function assertFusion(lane: string, def: StageDef, fusionSlots: readonly string[] | undefined): void {
  const fusion = def.fusion;
  if (fusion === undefined) return;
  if (isImplementClassStage(def.name) || Boolean(def.host)) {
    throw new CompileError(`fusion is not allowed on implement-class or host stages`, lane, def.name);
  }
  // Defence in depth: lanes built in code bypass the YAML schema, and a bad mode would otherwise
  // degrade to a silent single-model step inside fusionRequestFromStage.
  if (!isFusionMode(fusion.mode)) {
    throw new CompileError(
      `unknown fusion mode ${String(fusion.mode)} (expected one of ${FUSION_MODES.join(", ")})`,
      lane,
      def.name,
    );
  }
  if (fusion.rounds !== undefined && fusion.mode !== "debate") {
    throw new CompileError(`fusion rounds is only valid for mode debate, not ${fusion.mode}`, lane, def.name);
  }
  const slots = fusion.slots;
  if (slots === undefined) return; // omitted slots means "the whole configured stack"
  const min = MULTI_SLOT_FUSION_MODES.has(fusion.mode) ? 2 : 1;
  if (slots.length < min) {
    throw new CompileError(
      `fusion mode ${fusion.mode} needs at least ${min} slot${min === 1 ? "" : "s"}, got ${slots.length}`,
      lane,
      def.name,
    );
  }
  if (fusionSlots === undefined || fusionSlots.length === 0) return;
  for (const entry of slots) {
    const name = slotName(entry);
    if (resolvesFromStack(entry) && !fusionSlots.includes(name)) {
      throw new CompileError(
        `unknown fusion slot ${name} (stack: ${fusionSlots.join(", ")})`,
        lane,
        def.name,
      );
    }
  }
}

function toStep(
  def: StageDef,
  hooks: StageHooks,
  timeout: number,
  lane: string,
  catalog: Catalog,
  fusionSlots?: readonly string[],
): Step {
  assertCatalog(lane, def, catalog);
  assertFusion(lane, def, fusionSlots);
  // Fusion fans out inside the agent hook; compile still emits one Step per YAML stage (no dependsOn).
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
  const yamlSteps = lane.stages.map((s) => toStep(s, hooks, timeout, lane.name, catalog, opts.fusionSlots));
  if (!yamlSteps.some((s) => s.kind === "host" && s.host === "escalate")) {
    yamlSteps.push(
      toStep({ name: "escalate", host: "escalate" }, hooks, timeout, lane.name, catalog, opts.fusionSlots),
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
