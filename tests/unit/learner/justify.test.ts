import { describe, expect, it } from "vitest";
import { AGENTS, CATALOG, agentsFor, isAgent } from "../../../src/lanes/catalog.js";
import { DEFAULT_V3_POLICY, type V3Policy } from "../../../src/v3/dispatch.js";
import {
  loadLearnerIfJustified,
  maybeLearnerAgent,
  type LedgerEvent,
} from "../../../src/v3/learner.js";
import { learnerJustified } from "../../../src/v3/learner.js";

function cfg(learnerEnabled: boolean): { v3: V3Policy } {
  const v3 = structuredClone(DEFAULT_V3_POLICY);
  v3.learner.enabled = learnerEnabled;
  return { v3 };
}

export function gapEvents(
  n: number,
  over: { signature?: string; saved?: number; cost?: number; codifyActive?: boolean; ts?: string } = {},
): LedgerEvent[] {
  const signature = over.signature ?? "gap:conftest-skip";
  const ts = over.ts ?? "2026-08-01T00:00:00.000Z";
  return Array.from({ length: n }, (_, i) => ({
    ts,
    type: "verifier-gap",
    ref: `run-${i}`,
    data: {
      signature,
      estimatedSavedUsd: over.saved ?? 30,
      estimatedLaneCost: over.cost ?? 10,
      ...(over.codifyActive === true ? { codifyActive: true } : {}),
    },
  }));
}

const NOW = new Date("2026-09-03T00:00:00.000Z");

describe("learnerJustified", () => {
  it("fails closed on empty or partial ledgers", () => {
    expect(learnerJustified([]).ok).toBe(false);
    expect(learnerJustified([]).reason).toMatch(/no verifier-gap/);
    expect(learnerJustified(gapEvents(19), { now: NOW }).ok).toBe(false);
  });

  it("is true for 20 matching gaps at 3x ROI with no active codify tool", () => {
    expect(learnerJustified(gapEvents(20), { now: NOW }).ok).toBe(true);
  });

  it("is false when that signature is already an active codified tool", () => {
    expect(learnerJustified(gapEvents(20, { codifyActive: true }), { now: NOW }).ok).toBe(false);
  });
});

describe("maybeLearnerAgent / loadLearnerIfJustified", () => {
  it("returns nothing for default cfg and an empty ledger", () => {
    expect(maybeLearnerAgent({ v3: DEFAULT_V3_POLICY }, [])).toBeNull();
    expect(loadLearnerIfJustified({ cfg: { v3: DEFAULT_V3_POLICY }, events: [] })).toEqual([]);
  });

  it("returns nothing when the flag is on but the ledger is unjustified", () => {
    expect(maybeLearnerAgent(cfg(true), gapEvents(19), { now: NOW })).toBeNull();
    expect(maybeLearnerAgent(cfg(true), [])).toBeNull();
  });

  it("returns learner only when the flag is on and the ledger is justified", () => {
    expect(maybeLearnerAgent(cfg(false), gapEvents(20), { now: NOW })).toBeNull();
    expect(maybeLearnerAgent(cfg(true), gapEvents(20), { now: NOW })).toBe("learner");
    expect(loadLearnerIfJustified({ cfg: cfg(true), events: gapEvents(20), now: NOW })).toEqual(["learner"]);
  });
});

describe("catalog gating", () => {
  it("keeps the built-in AGENTS roster at 13 without learner", () => {
    expect(AGENTS).toHaveLength(13);
    expect(AGENTS).not.toContain("learner");
    expect(CATALOG.agents).toBe(AGENTS);
    expect(isAgent("learner")).toBe(false);
  });

  it("agentsFor appends learner only when both gates pass", () => {
    expect(agentsFor({ v3: DEFAULT_V3_POLICY }, [])).toHaveLength(13);
    expect(agentsFor({ v3: DEFAULT_V3_POLICY }, [])).not.toContain("learner");
    expect(agentsFor(cfg(true), [])).toHaveLength(13);
    expect(agentsFor(cfg(true), gapEvents(19), { now: NOW })).toHaveLength(13);
    const on = agentsFor(cfg(true), gapEvents(20), { now: NOW });
    expect(on).toHaveLength(14);
    expect(on).toContain("learner");
    expect(AGENTS).toHaveLength(13);
  });
});
