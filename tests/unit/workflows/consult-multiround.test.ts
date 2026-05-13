import { describe, it, expect } from "vitest";
import { buildConsultWorkflow } from "../../../src/workflows/consult.js";

describe("buildConsultWorkflow multi-round — Phase 6", () => {
  it("rounds=1 produces the legacy single-round DAG with original step names", () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 1);
    const names = wf.steps.map((s) => s.name);
    expect(names).toEqual([
      "dispatch",
      "position-eng",
      "position-valid",
      "position-invest",
      "adversarial-eng",
      "adversarial-valid",
      "adversarial-invest",
      "synthesis",
    ]);
    // Round 1 positions depend on dispatch only.
    const posEng = wf.steps.find((s) => s.name === "position-eng")!;
    expect(posEng.dependsOn).toEqual(["dispatch"]);
    // Round 1 adversarials depend on all round-1 positions.
    const advEng = wf.steps.find((s) => s.name === "adversarial-eng")!;
    expect(advEng.dependsOn?.sort()).toEqual(["position-eng", "position-invest", "position-valid"]);
    // Synthesis depends on round-1 adversarials.
    const synth = wf.steps.find((s) => s.name === "synthesis")!;
    expect(synth.dependsOn?.sort()).toEqual(["adversarial-eng", "adversarial-invest", "adversarial-valid"]);
  });

  it("rounds=2 produces two position+adversarial levels, then synthesis", () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 2);
    const names = wf.steps.map((s) => s.name);
    expect(names).toEqual([
      "dispatch",
      "position-eng",
      "position-valid",
      "position-invest",
      "adversarial-eng",
      "adversarial-valid",
      "adversarial-invest",
      "position-eng-r2",
      "position-valid-r2",
      "position-invest-r2",
      "adversarial-eng-r2",
      "adversarial-valid-r2",
      "adversarial-invest-r2",
      "synthesis",
    ]);
  });

  it("round-2 position depends on every round-1 adversarial", () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 2);
    const r2PosEng = wf.steps.find((s) => s.name === "position-eng-r2")!;
    expect(r2PosEng.dependsOn?.sort()).toEqual([
      "adversarial-eng",
      "adversarial-invest",
      "adversarial-valid",
    ]);
  });

  it("synthesis depends on the LAST round's adversarials", () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 2);
    const synth = wf.steps.find((s) => s.name === "synthesis")!;
    expect(synth.dependsOn?.sort()).toEqual([
      "adversarial-eng-r2",
      "adversarial-invest-r2",
      "adversarial-valid-r2",
    ]);
  });

  it("rounds=3 generates 3 full position+adversarial levels", () => {
    const wf = buildConsultWorkflow(undefined, "consult-test", 3);
    const names = wf.steps.map((s) => s.name);
    expect(names).toContain("position-eng");
    expect(names).toContain("position-eng-r2");
    expect(names).toContain("position-eng-r3");
    expect(names).toContain("adversarial-eng-r3");
    const synth = wf.steps.find((s) => s.name === "synthesis")!;
    expect(synth.dependsOn?.sort()).toEqual([
      "adversarial-eng-r3",
      "adversarial-invest-r3",
      "adversarial-valid-r3",
    ]);
  });

  it("team subset filters per-round step generation", () => {
    const wf = buildConsultWorkflow(["eng", "valid"], "consult-test", 2);
    const names = wf.steps.map((s) => s.name);
    // Only eng + valid leads at every round.
    expect(names).toContain("position-eng");
    expect(names).toContain("position-valid");
    expect(names).not.toContain("position-invest");
    expect(names).toContain("position-eng-r2");
    expect(names).toContain("position-valid-r2");
    expect(names).not.toContain("position-invest-r2");
    // Round-2 positions depend on round-1 eng + valid adversarials.
    const r2PosEng = wf.steps.find((s) => s.name === "position-eng-r2")!;
    expect(r2PosEng.dependsOn?.sort()).toEqual([
      "adversarial-eng",
      "adversarial-valid",
    ]);
  });

  it("rounds=0 or negative clamps to 1", () => {
    const wfZero = buildConsultWorkflow(undefined, "wf", 0);
    expect(wfZero.steps.map((s) => s.name)).toContain("synthesis");
    expect(wfZero.steps.map((s) => s.name)).toContain("position-eng");
    expect(wfZero.steps.map((s) => s.name)).not.toContain("position-eng-r2");
    const wfNeg = buildConsultWorkflow(undefined, "wf", -3);
    expect(wfNeg.steps.map((s) => s.name)).not.toContain("position-eng-r2");
  });
});
