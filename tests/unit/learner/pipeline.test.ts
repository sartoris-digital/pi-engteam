import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { DEFAULT_V3_POLICY, type V3Policy } from "../../../src/v3/dispatch.js";
import { runLearnerGap, type LearnerExecutor } from "../../../src/v3/learner.js";
import { gapEvents } from "./justify.test.js";
import { withTmpHome } from "../../helpers/tmp-home.js";
import { stagingDir } from "../../../src/codify/layout.js";

function cfg(enabled: boolean): { v3: V3Policy } {
  const v3 = structuredClone(DEFAULT_V3_POLICY);
  v3.learner.enabled = enabled;
  return { v3 };
}

const NOW = new Date("2026-09-03T00:00:00.000Z");

describe("runLearnerGap", () => {
  it("skips without calling the executor when gates fail", async () => {
    let calls = 0;
    const executor: LearnerExecutor = {
      async run() {
        calls += 1;
        return { ok: true };
      },
    };
    const skippedFlag = await runLearnerGap(
      { signature: "gap:conftest-skip", stagingId: "gap-1" },
      { cfg: cfg(false), events: gapEvents(20), executor, now: NOW, home: "/tmp" },
    );
    expect(skippedFlag).toEqual({ skipped: true, reason: expect.stringMatching(/learner-flag-off|disabled/) });
    expect(calls).toBe(0);

    const skippedLedger = await runLearnerGap(
      { signature: "gap:conftest-skip", stagingId: "gap-1" },
      { cfg: cfg(true), events: [], executor, now: NOW, home: "/tmp" },
    );
    expect(skippedLedger.skipped).toBe(true);
    expect(calls).toBe(0);
  });

  it("runs once when gated on and records staged, never active", async () => {
    await withTmpHome(async (home) => {
      const calls: Array<{ agent: string; extraUpsert: string[]; tools: readonly string[]; promote: boolean }> = [];
      const executor: LearnerExecutor = {
        async run(req) {
          calls.push(req);
          return { ok: true };
        },
      };
      const result = await runLearnerGap(
        { signature: "gap:conftest-skip", stagingId: "gap-1" },
        { cfg: cfg(true), events: gapEvents(20), executor, now: NOW, home },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.agent).toBe("learner");
      expect(calls[0]?.promote).toBe(false);
      expect(calls[0]?.tools).not.toContain("bash");
      expect(calls[0]?.extraUpsert).toContain(stagingDir(home, "gap-1"));
      expect(result).toEqual({
        skipped: false,
        state: "staged",
        stagingDir: stagingDir(home, "gap-1"),
      });
      expect(result).not.toMatchObject({ state: "active" });
      expect(join(home, "codified", ".staging", "gap-1")).toBe(stagingDir(home, "gap-1"));
    });
  });
});
