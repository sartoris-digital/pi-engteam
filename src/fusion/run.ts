import type { FactoryEvent, StepResult } from "../engine/types.js";
import { fenceArray, fenceData } from "../safety/fence.js";
import type { WorkerExecutor, WorkerRequest, WorkerResult } from "../runtime/types.js";
import { mergeAdversarial } from "./adversarial.js";
import { mergeDebate } from "./debate.js";
import { mergeFuse } from "./fuse.js";
import { mergeOpinion } from "./opinion.js";
import { mergeSample } from "./sample.js";
import type { FusionMode, FusionRequest, FusionSlot, SlotResult } from "./types.js";
import { isFusionMode } from "./types.js";
import { mergeVeto } from "./veto.js";

export interface RunFusionOptions {
  req: FusionRequest;
  executor: WorkerExecutor;
  base: WorkerRequest;
  merge: (slots: SlotResult[]) => StepResult;
  slotTimeoutMs: number;
  off?: boolean;
  emit?: (event: FactoryEvent) => void;
}

export function mergeForMode(mode: FusionMode): (slots: SlotResult[]) => StepResult {
  switch (mode) {
    case "sample":
      return mergeSample;
    case "opinion":
      return mergeOpinion;
    case "fuse":
      return mergeFuse;
    case "debate":
      return mergeDebate;
    case "adversarial":
      return mergeAdversarial;
    case "veto":
      return mergeVeto;
    case "collaborate":
      return mergeOpinion;
  }
}

function parseSlots(raw: unknown, stack: FusionSlot[]): FusionSlot[] {
  if (!Array.isArray(raw)) return stack.slice();
  const out: FusionSlot[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const found = stack.find((s) => s.name === item);
      if (found) out.push(found);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as { name?: unknown; model?: unknown; thinking?: unknown };
    if (typeof rec.name === "string" && typeof rec.model === "string") {
      out.push({
        name: rec.name,
        model: rec.model,
        ...(typeof rec.thinking === "string" ? { thinking: rec.thinking } : {}),
      });
    } else if (typeof rec.name === "string") {
      const found = stack.find((s) => s.name === rec.name);
      if (found) out.push(found);
    }
  }
  return out;
}

export function fusionRequestFromStage(
  stage: { name: string; fusion?: unknown },
  stack: FusionSlot[] = [],
): FusionRequest | null {
  const raw = stage.fusion;
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.mode !== "string" || !isFusionMode(rec.mode)) return null;
  const slots = parseSlots(rec.slots, stack);
  const rounds = typeof rec.rounds === "number" && Number.isFinite(rec.rounds) ? Math.min(3, Math.max(1, rec.rounds)) : undefined;
  return {
    mode: rec.mode,
    slots,
    stage: stage.name,
    ...(typeof rec.synthesizer === "string" ? { synthesizer: rec.synthesizer } : {}),
    ...(rec.syncBack === true ? { syncBack: true } : {}),
    ...(rounds === undefined ? {} : { rounds }),
  };
}

function cloneRequest(base: WorkerRequest, slot: FusionSlot, stage: string, timeoutMs: number): WorkerRequest {
  return {
    ...base,
    stage,
    timeoutMs,
    agent: { ...base.agent, model: slot.model },
  };
}

function textOf(worker: WorkerResult): string {
  const issues = worker.verdict?.issues;
  if (issues && issues.length > 0) return issues.join("\n");
  const learnings = worker.verdict?.learnings;
  if (learnings && learnings.length > 0) return learnings.join("\n");
  return worker.stderrTail;
}

function toSlot(slot: FusionSlot, worker: WorkerResult, nonce: string): SlotResult {
  const text = textOf(worker);
  return {
    name: slot.name,
    model: slot.model,
    text,
    ...(worker.verdict?.verdict ? { verdict: worker.verdict.verdict } : {}),
    ...(worker.verdict?.artifacts?.[0] ? { artifact: worker.verdict.artifacts[0] } : {}),
    ...(worker.timedOut ? { timedOut: true } : {}),
    durationMs: worker.durationMs,
    ...(worker.verdict?.flags ? { flags: worker.verdict.flags } : {}),
    ...(worker.verdict?.issues ? { issues: worker.verdict.issues } : {}),
    fenced: fenceData(text, nonce, `FUSION-${slot.name}`),
  };
}

function resolveSlots(opts: RunFusionOptions): { slots: FusionSlot[]; fanOut: boolean } {
  if (opts.off === true || opts.req.slots.length === 0) {
    const model = opts.req.synthesizer ?? opts.base.agent.model;
    const name = opts.req.synthesizer ?? "A";
    return { slots: [{ name, model }], fanOut: false };
  }
  return { slots: opts.req.slots, fanOut: true };
}

async function runSlot(
  executor: WorkerExecutor,
  req: WorkerRequest,
  slot: FusionSlot,
  nonce: string,
): Promise<SlotResult> {
  try {
    const worker = await executor.run(req);
    return toSlot(slot, worker, nonce);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: slot.name, model: slot.model, text: "", error: message };
  }
}

export async function runFusion(opts: RunFusionOptions): Promise<StepResult> {
  const { slots, fanOut } = resolveSlots(opts);
  const started = slots.map((slot) => {
    const stage = fanOut ? `${opts.req.stage}.slot-${slot.name}` : opts.req.stage;
    const req = cloneRequest(opts.base, slot, stage, opts.slotTimeoutMs);
    return runSlot(opts.executor, req, slot, opts.base.nonce);
  });
  const results = await Promise.all(started);
  fenceArray(
    results.map((r) => r.text),
    opts.base.nonce,
    "FUSION",
  );
  return opts.merge(results);
}
