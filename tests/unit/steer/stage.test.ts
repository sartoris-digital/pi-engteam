import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceRecord } from "../../../src/engine/evidence.js";
import {
  configPolicyResolver,
  makeSteerStep,
  readSteerDecision,
  resolveSteerMode,
  steerDecisionPath,
  steerDecisionsDir,
  writeSteerDecision,
  type SteerHooks,
} from "../../../src/steer/stage.js";
import type { SteerAction } from "../../../src/steer/dialog.js";
import { makeStepContext } from "../../helpers/steer-fixtures.js";

const MATRIX = [
  ["always", "low", "pause"],
  ["always", "elevated", "pause"],
  ["elevated", "low", "auto"],
  ["elevated", "elevated", "pause"],
  ["never", "low", "auto"],
  ["never", "elevated", "auto"],
] as const;

let tmp: string;
let runDir: string;
let written: EvidenceRecord[];
let rehashCalls: number;
let hooks: SteerHooks;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sdlc-stage-"));
  runDir = join(tmp, "runs", "run-0001");
  await mkdir(runDir, { recursive: true });
  written = [];
  rehashCalls = 0;
  hooks = {
    writeEvidence: async (dir, record) => {
      written.push(record);
      return join(dir, "evidence", `stage-steer-r${record.round}.json`);
    },
    rehash: async () => {
      rehashCalls += 1;
      return { ok: true, note: "v0: no gate stage" };
    },
    now: () => new Date("2026-09-02T10:00:00Z"),
  };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("resolveSteerMode", () => {
  it.each(MATRIX)("steering=%s tier=%s → %s", (policy, tier, mode) => {
    expect(resolveSteerMode(policy, tier)).toBe(mode);
  });
});

describe("makeSteerStep policy matrix", () => {
  it.each(MATRIX)("steering=%s tier=%s → %s", async (policy, tier, mode) => {
    const ctx = makeStepContext(runDir, { state: { tier }, cfg: { steering: policy } });
    const step = makeSteerStep(configPolicyResolver, hooks);
    expect(step).toMatchObject({ name: "steer", kind: "human", gates: [], onFail: "escalate:needs-decision", locked: true });

    const result = await step.run(ctx);
    expect(result.verdict).toBe("PASS");
    expect(result.artifacts?.["steer-packet"]).toBe(join(runDir, "steer-packet.md"));
    expect(result.artifacts?.["steer-packet-json"]).toBe(join(runDir, "steer-packet.json"));
    await stat(join(runDir, "steer-packet.md"));
    await stat(join(runDir, "steer-packet.json"));

    if (mode === "pause") {
      expect(result.pauseForUser).toEqual({ reason: "steer", packetPath: join(runDir, "steer-packet.md") });
      expect(result.evidence).toBeUndefined();
      expect(written).toEqual([]);
      await expect(readdir(steerDecisionsDir(runDir))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result.pauseForUser).toBeUndefined();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        stage: "steer",
        round: 1,
        agent: "human",
        verdict: "AUTO",
        artifacts: [],
        commands: [],
        synthesized: [],
        timedOut: false,
        headSha: "a".repeat(40),
        at: "2026-09-02T10:00:00.000Z",
      });
      expect(written[0]!.humanIntervened).toBeUndefined();
      expect(written[0]!.predicates).toEqual([
        { name: "steer-policy", ok: true, note: `auto-approved: steering=${policy}, tier=${tier}` },
      ]);
      expect(result.evidence).toEqual({ verdict: "AUTO", predicates: written[0]!.predicates });
      expect(result.artifacts?.["steer-evidence"]).toBe(join(runDir, "evidence", "stage-steer-r1.json"));
      const archived = JSON.parse(await readFile(join(steerDecisionsDir(runDir), "steer-1.json"), "utf8"));
      expect(archived).toEqual({
        schemaVersion: 1,
        action: "auto",
        policy,
        tier,
        decidedAt: "2026-09-02T10:00:00.000Z",
        by: "auto",
      });
    }
  });

  it("uses the injected policy resolver rather than cfg.steering", async () => {
    const ctx = makeStepContext(runDir, { cfg: { steering: "always" } });
    const result = await makeSteerStep(() => "never", hooks).run(ctx);
    expect(result.pauseForUser).toBeUndefined();
    expect(written[0]?.verdict).toBe("AUTO");
  });

  it("uses the last host commit as headSha when there is one", async () => {
    const ctx = makeStepContext(runDir, { state: { hostCommits: ["b".repeat(40), "c".repeat(40)] }, cfg: { steering: "never" } });
    await makeSteerStep(configPolicyResolver, hooks).run(ctx);
    expect(written[0]?.headSha).toBe("c".repeat(40));
  });
});

describe("makeSteerStep decision handling", () => {
  async function decide(action: SteerAction, notes?: string, pointer = true) {
    const ctx = makeStepContext(runDir, { cfg: { steering: "always" } });
    const decision = notes === undefined ? { action } : { action, notes };
    const path = await writeSteerDecision(runDir, decision, "command", hooks.now);
    if (pointer) ctx.state.artifacts["steer-decision"] = path;
    const result = await makeSteerStep(configPolicyResolver, hooks).run(ctx);
    return { ctx, path, result };
  }

  it("writeSteerDecision persists a 0600 JSON file at the one live path and refuses pending", async () => {
    const path = await writeSteerDecision(runDir, { action: "steer", notes: "n" }, "tui", hooks.now);
    expect(path).toBe(steerDecisionPath(runDir));
    expect(path).toBe(join(runDir, "steer-decision.json"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readSteerDecision(path)).toEqual({
      schemaVersion: 1,
      action: "steer",
      notes: "n",
      decidedAt: "2026-09-02T10:00:00.000Z",
      by: "tui",
    });
    await expect(writeSteerDecision(runDir, { action: "pending" })).rejects.toThrow(/pending/);
    expect(await readSteerDecision(join(runDir, "missing.json"))).toBeNull();
  });

  it("approve → PASS, evidence PASS with humanIntervened, decision archived and not replayed", async () => {
    const { path, result } = await decide("approve");
    expect(result).toMatchObject({ verdict: "PASS" });
    expect(result.pauseForUser).toBeUndefined();
    expect(result.escalate).toBeUndefined();
    expect(result.artifacts?.["steer-decision-1"]).toBe(join(steerDecisionsDir(runDir), "steer-1.json"));
    expect(result.artifacts?.["steer-evidence"]).toBe(join(runDir, "evidence", "stage-steer-r1.json"));
    expect(await readSteerDecision(path)).toBeNull();
    expect(await readSteerDecision(join(steerDecisionsDir(runDir), "steer-1.json"))).toEqual({
      schemaVersion: 1,
      action: "approve",
      decidedAt: "2026-09-02T10:00:00.000Z",
      by: "command",
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ stage: "steer", round: 1, agent: "human", verdict: "PASS", humanIntervened: { turns: 1 } });
    expect(written[0]!.predicates).toEqual([{ name: "steer-decision", ok: true, note: "approve" }]);
    expect(result.evidence).toEqual({ verdict: "PASS", predicates: written[0]!.predicates });
  });

  it("steer with notes → PASS and a fenced human-input file", async () => {
    const { ctx, result } = await decide("steer", "Keep the badge row.\n\nDo not touch docs/.");
    expect(result.verdict).toBe("PASS");
    const humanInput = result.artifacts?.humanInput;
    expect(humanInput).toBe(join(runDir, "human-input", "steer-1.md"));
    const text = await readFile(humanInput!, "utf8");
    expect(text.split("\n")[0]).toBe("<!-- pi-sdlc-factory generated · run run-0001 · do not commit -->");
    expect(text).toContain("Keep the badge row.");
    expect(text).toContain(ctx.nonce);
    // human-input/ holds only the fenced notes files
    expect(await readdir(join(runDir, "human-input"))).toEqual(["steer-1.md"]);
    expect(written[0]!.predicates).toEqual([{ name: "steer-decision", ok: true, note: "steer" }]);
  });

  it("steer without notes behaves like approve (no human-input file)", async () => {
    const { result } = await decide("steer");
    expect(result.verdict).toBe("PASS");
    expect(result.artifacts?.humanInput).toBeUndefined();
    await expect(readdir(join(runDir, "human-input"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replan with notes → NEEDS_MORE ['replan'] with the notes fenced for the planner", async () => {
    const { result } = await decide("replan", "Split the docs step out.");
    expect(result.verdict).toBe("NEEDS_MORE");
    expect(result.issues).toEqual(["replan"]);
    expect(result.escalate).toBeUndefined();
    expect(result.artifacts?.humanInput).toBe(join(runDir, "human-input", "steer-1.md"));
    expect(await readFile(result.artifacts!.humanInput!, "utf8")).toContain("Split the docs step out.");
    expect(written[0]).toMatchObject({ verdict: "NEEDS_MORE" });
  });

  it("edit-approve → runs the rehash hook then PASS", async () => {
    const { result } = await decide("edit-approve");
    expect(rehashCalls).toBe(1);
    expect(result.verdict).toBe("PASS");
    expect(written[0]!.predicates).toEqual([
      { name: "steer-decision", ok: true, note: "edit-approve" },
      { name: "steer-edit-rehash", ok: true, note: "v0: no gate stage" },
    ]);
  });

  it("edit-approve with a failed rehash → FAIL escalate gate-invalid", async () => {
    hooks.rehash = async () => {
      rehashCalls += 1;
      return { ok: false, note: "RED baseline is no longer red" };
    };
    const { result } = await decide("edit-approve");
    expect(rehashCalls).toBe(1);
    expect(result.verdict).toBe("FAIL");
    expect(result.escalate).toBe("gate-invalid");
    expect(result.issues).toEqual(["RED baseline is no longer red"]);
    expect(written[0]!.predicates[1]).toEqual({ name: "steer-edit-rehash", ok: false, note: "RED baseline is no longer red" });
  });

  it("drop → FAIL escalate needs-decision", async () => {
    const { result } = await decide("drop");
    expect(result.verdict).toBe("FAIL");
    expect(result.escalate).toBe("needs-decision");
    expect(result.issues).toEqual(["dropped at steer by operator"]);
    expect(written[0]).toMatchObject({ verdict: "FAIL" });
  });

  it("a consumed decision is not replayed: the next pass pauses again and counts as round 2", async () => {
    await decide("approve");
    const ctx2 = makeStepContext(runDir, { cfg: { steering: "always" } });
    ctx2.state.artifacts["steer-decision"] = steerDecisionPath(runDir);
    const paused = await makeSteerStep(configPolicyResolver, hooks).run(ctx2);
    expect(paused.pauseForUser?.reason).toBe("steer");

    const { result } = await decide("steer", "second round notes");
    expect(result.artifacts?.["steer-decision-2"]).toBe(join(steerDecisionsDir(runDir), "steer-2.json"));
    expect(result.artifacts?.humanInput).toBe(join(runDir, "human-input", "steer-2.md"));
    expect(written.map((r) => r.round)).toEqual([1, 2]);
  });

  it("falls back to <runDir>/steer-decision.json when state.artifacts has no pointer", async () => {
    const { result } = await decide("approve", undefined, false);
    expect(result.verdict).toBe("PASS");
    expect(result.artifacts?.["steer-decision-1"]).toBeDefined();
  });

  it("rejects a malformed decision file instead of guessing", async () => {
    await writeFile(steerDecisionPath(runDir), JSON.stringify({ action: "yolo" }));
    const ctx = makeStepContext(runDir);
    await expect(makeSteerStep(configPolicyResolver, hooks).run(ctx)).rejects.toThrow(/invalid steer decision/);
    await writeFile(steerDecisionPath(runDir), "{not json");
    await expect(makeSteerStep(configPolicyResolver, hooks).run(ctx)).rejects.toThrow(/invalid steer decision/);
  });
});
