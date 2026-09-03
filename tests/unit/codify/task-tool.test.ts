import { describe, expect, it } from "vitest";
import {
  EFFECT_PLAN_SCHEMA,
  lintTaskToolNetwork,
  nextSupervised,
  parseEffectPlan,
  taskToolProfile,
  unattendedAllowed,
} from "../../../src/codify/task-tool.js";
import type { Manifest } from "../../../src/codify/types.js";
import type { CodifyConfig } from "../../../src/config/schema.js";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    name: "sync-aem",
    version: 1,
    class: "task-tool",
    scope: "repo",
    stage: "implement",
    kind: "chore",
    signature: "sig",
    purpose: "sync aem",
    whenNot: [],
    inputs: [{ name: "targetEnv", type: "enum", provenance: "title:env" }],
    matcher: { titlePatterns: [], planStepPatterns: [], pathGlobs: [] },
    decisions: [],
    postconditions: [],
    sideEffects: { writeGlobs: [], readGlobs: [], allowedCommands: [], writesWorkspace: false },
    network: { allow: ["{targetEnv}.example.com"] },
    secrets: [],
    checks: [],
    provenance: { sourceRuns: [] },
    metadata: {
      "pi-sdlc-factory-codified": true,
      toolSha256: "0",
      manifestSha256: "0",
      skillSha256: "0",
    },
    ...over,
  };
}

const cfgNever: CodifyConfig = {
  enabled: true,
  repos: [],
  eligibility: "landed",
  minRecurrence: 2,
  schedule: "idle+daily@03:00",
  window: "30d/300",
  reserveUsd: 15,
  maxPerDay: 3,
  maxCandidatesPerRun: 2,
  requireIdleLanes: 1,
  forwardRoi: 3,
  dispatch: "exact",
  pythonDeps: [],
  maxActivePerRepo: 25,
  maxActiveGlobal: 50,
  staleDays: 90,
  shadowAgreeToActivate: 2,
  demoteAfterFailures: 2,
  cooldownDays: 30,
  taskTools: { unattended: "never" },
};

describe("parseEffectPlan", () => {
  it("parses a JSON line with dryRun: true", () => {
    const stdout = "noise\n" + JSON.stringify({ dryRun: true, effects: [{ op: "replicate", target: "/content/site" }] }) + "\n";
    const plan = parseEffectPlan(stdout);
    expect(plan.dryRun).toBe(true);
    expect(plan.effects).toEqual([{ op: "replicate", target: "/content/site" }]);
    expect(EFFECT_PLAN_SCHEMA).toBeDefined();
  });

  it("rejects missing dryRun: true", () => {
    expect(() => parseEffectPlan(JSON.stringify({ effects: [] }))).toThrow(/dryRun/);
    expect(() => parseEffectPlan(JSON.stringify({ dryRun: false, effects: [] }))).toThrow(/dryRun/);
    expect(() => parseEffectPlan("no json here")).toThrow();
  });
});

describe("taskToolProfile", () => {
  it("substitutes {targetEnv} into networkAllow from inputs", () => {
    const profile = taskToolProfile(manifest(), { workspaceDir: "/ws", runDir: "/run" }, { targetEnv: "dev" });
    expect(profile.networkAllow).toEqual(["dev.example.com"]);
    expect(profile.network).toBe("deny");
    expect(profile.workspaceDir).toBe("/ws");
    expect(profile.runDir).toBe("/run");
  });
});

describe("nextSupervised", () => {
  it("walks assist → supervised-1 → supervised-2 → active on success", () => {
    expect(nextSupervised("assist", "success")).toBe("supervised-1");
    expect(nextSupervised("supervised-1", "success")).toBe("supervised-2");
    expect(nextSupervised("supervised-2", "success")).toBe("active");
  });

  it("stays in place on fail and retires on out-of-plan", () => {
    expect(nextSupervised("assist", "fail")).toBe("assist");
    expect(nextSupervised("supervised-1", "fail")).toBe("supervised-1");
    expect(nextSupervised("active", "fail")).toBe("active");
    expect(nextSupervised("assist", "out-of-plan")).toBe("retired");
    expect(nextSupervised("active", "out-of-plan")).toBe("retired");
  });
});

describe("unattendedAllowed", () => {
  it("is false for task-tool unless taskTools.unattended is always", () => {
    expect(unattendedAllowed(cfgNever, "task-tool")).toBe(false);
    expect(unattendedAllowed({ ...cfgNever, taskTools: { unattended: "always" } }, "task-tool")).toBe(true);
    expect(unattendedAllowed(cfgNever, "stage-tool")).toBe(true);
  });
});

describe("lintTaskToolNetwork", () => {
  it("fails a urllib call to a host that is not allowlisted", () => {
    const src = 'import urllib.request\nurllib.request.urlopen("https://evil.example.com/x")\n';
    expect(lintTaskToolNetwork(src, ["dev.example.com"]).ok).toBe(false);
  });

  it("passes when every http(s) literal host is allowlisted", () => {
    const src = 'import urllib.request\nurllib.request.urlopen("https://dev.example.com/x")\n';
    expect(lintTaskToolNetwork(src, ["dev.example.com"]).ok).toBe(true);
  });
});
