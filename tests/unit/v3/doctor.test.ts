import { describe, expect, it } from "vitest";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import {
  collectV3DoctorLines,
  formatV3DoctorReport,
  isV3EventType,
  v3SetupDefaults,
  v3StatusCompletions,
  V3_EVENT_TYPES,
} from "../../../src/v3/doctor.js";
import { completeFactoryArgs } from "../../../src/commands/completions.js";
import { runGlobalInterview } from "../../../src/setup/interview.js";
import { AGENTS } from "../../../src/lanes/catalog.js";

const sandboxProbe = { available: true, provider: "sandbox-exec" as const, detail: "ok" };

describe("v3 doctor stubs", () => {
  it("prints each flag from effective config, including mergeQueue: false", () => {
    const lines = collectV3DoctorLines({ cfg: { v3: DEFAULT_V3_POLICY }, agents: AGENTS, events: [] });
    const flags = lines.find((l) => l.name === "v3.flags");
    expect(flags?.detail).toMatch(/mergeQueue:\s*false/);
    expect(flags?.detail).toMatch(/learner:\s*false/);
    expect(flags?.detail).toMatch(/collaborateExecution:\s*false/);
    expect(formatV3DoctorReport(lines)).toMatch(/mergeQueue:\s*false/);
    const learner = lines.find((l) => l.name === "learner");
    expect(learner?.detail).toMatch(/justified:\s*false/);
    expect(learner?.detail).toMatch(/enabled:\s*false/);
    expect(learner?.detail).toMatch(/registered:\s*false/);
    const merge = lines.find((l) => l.name === "mergeQueue");
    expect(merge?.detail).toMatch(/off \(factory never merges\)/);
  });
});

describe("v3 setup defaults", () => {
  it("leaves every v3 enabled flag false when --answers omit v3 keys", async () => {
    const defaults = v3SetupDefaults();
    for (const value of Object.values(defaults)) {
      expect(value.enabled).toBe(false);
    }
    const result = await runGlobalInterview(
      {
        async select(_title, options) {
          return options[0];
        },
        async input() {
          return "";
        },
        async confirm(_title, initial = true) {
          return initial;
        },
      },
      { probes: { sandbox: sandboxProbe }, answers: { coAuthoredBy: true, maxLanes: 1 } },
    );
    expect(result.diff.operator).not.toHaveProperty("v3");
    expect(defaults.learner.enabled).toBe(false);
    expect(defaults.mergeQueue.enabled).toBe(false);
  });
});

describe("v3 status completions and events", () => {
  it("offers setfit and learner status verbs", () => {
    const items = v3StatusCompletions();
    expect(items.map((i) => i.value)).toEqual(["setfit status", "learner status"]);
    expect(completeFactoryArgs("setfit", { lanes: [], repos: [], runs: [] })?.map((i) => i.value)).toContain(
      "setfit status",
    );
    expect(completeFactoryArgs("learner", { lanes: [], repos: [], runs: [] })?.map((i) => i.value)).toContain(
      "learner status",
    );
  });

  it("allows factory.v3.* event types on lifecycle/safety", () => {
    expect(V3_EVENT_TYPES.every((t) => t.startsWith("factory.v3."))).toBe(true);
    expect(isV3EventType("factory.v3.learner.skip")).toBe(true);
    expect(isV3EventType("factory.codified.active")).toBe(false);
  });
});
