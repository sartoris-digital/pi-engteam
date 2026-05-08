import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createRunState,
  loadRunState,
  saveRunState,
  withRunStateLock,
} from "../../../src/adw/RunState.js";

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "runstate-lock-"));
});

async function bootstrap(runId: string): Promise<void> {
  const state = await createRunState({
    runId,
    workflow: "test",
    goal: "g",
    budget: {},
  });
  await saveRunState(runsDir, state);
}

describe("withRunStateLock — Phase 4.5 M-3 concurrency", () => {
  it("serializes concurrent load-modify-save sequences", async () => {
    const runId = "r1";
    await bootstrap(runId);

    // Two concurrent +1 increments. Without the lock, classic lost-update;
    // with the lock, end value must be exactly 2.
    const inc = () =>
      withRunStateLock(runsDir, runId, async () => {
        const s = await loadRunState(runsDir, runId);
        if (!s) throw new Error("missing");
        // Simulate yield between read and write so any unlocked race
        // would interleave.
        await new Promise((res) => setTimeout(res, 10));
        await saveRunState(runsDir, { ...s, iteration: s.iteration + 1 });
      });

    await Promise.all([inc(), inc()]);
    const final = await loadRunState(runsDir, runId);
    expect(final?.iteration).toBe(2);
  });

  it("forces stale-read → cancel write → terminal re-read; terminal save honors cancel", async () => {
    // Round-1 M-2 fix: this test now drives the failure mode rather than
    // accepting it. The terminal save reads state, then we make it WAIT
    // until /run-cancel has written phase=cancelling, then it re-reads
    // INSIDE its critical section. Without the round-3 mutex + the
    // round-2 reload-before-save pattern, the terminal save would write
    // "done" using the stale snapshot. With both pieces in place, the
    // re-read sees "cancelling" and final phase is "cancelled".
    const runId = "r2";
    await bootstrap(runId);

    // Barrier coordination.
    let terminalReadDone!: () => void;
    const terminalReadGate = new Promise<void>((res) => {
      terminalReadDone = res;
    });
    let cancelWriteDone!: () => void;
    const cancelWriteGate = new Promise<void>((res) => {
      cancelWriteDone = res;
    });

    // Terminal-save worker: reads stale state, signals it has read,
    // waits for cancel to write, then enters the critical section,
    // re-reads inside the lock, and saves.
    const terminalSave = (async () => {
      const stale = await loadRunState(runsDir, runId);
      if (!stale) throw new Error("missing");
      terminalReadDone();
      await cancelWriteGate;
      // Now enter the lock and re-read on the inside.
      await withRunStateLock(runsDir, runId, async () => {
        const fresh = await loadRunState(runsDir, runId);
        const next = fresh?.phase === "cancelling" || fresh?.phase === "cancelled"
          ? { ...stale, status: "aborted" as const, phase: "cancelled" as const }
          : { ...stale, status: "succeeded" as const, phase: "done" as const };
        await saveRunState(runsDir, next);
      });
    })();

    // Cancel worker: waits for terminal to read, then takes the lock,
    // writes phase=cancelling, signals.
    const cancel = (async () => {
      await terminalReadGate;
      await withRunStateLock(runsDir, runId, async () => {
        const s = await loadRunState(runsDir, runId);
        if (!s) throw new Error("missing");
        await saveRunState(runsDir, { ...s, phase: "cancelling" });
      });
      cancelWriteDone();
    })();

    await Promise.all([terminalSave, cancel]);
    const final = await loadRunState(runsDir, runId);
    // The terminal save MUST have honored the cancel — the round-2
    // reload-before-save pattern requires final phase=cancelled and
    // status=aborted, never "done"/"succeeded".
    expect(final?.phase).toBe("cancelled");
    expect(final?.status).toBe("aborted");
  });

  it("propagates errors from the protected callback to the caller", async () => {
    const runId = "r3";
    await bootstrap(runId);
    await expect(
      withRunStateLock(runsDir, runId, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    // Subsequent waiters still acquire the lock cleanly.
    const ok = await withRunStateLock(runsDir, runId, async () => "ok" as const);
    expect(ok).toBe("ok");
  });

  it("a failing prior turn does not block subsequent waiters", async () => {
    const runId = "r4";
    await bootstrap(runId);
    const failing = withRunStateLock(runsDir, runId, async () => {
      throw new Error("first failed");
    }).catch(() => "ignored");
    const winner = withRunStateLock(runsDir, runId, async () => {
      const s = await loadRunState(runsDir, runId);
      if (!s) throw new Error("missing");
      await saveRunState(runsDir, { ...s, status: "running" });
      return "second-ran";
    });
    const [a, b] = await Promise.all([failing, winner]);
    expect(a).toBe("ignored");
    expect(b).toBe("second-ran");
    const final = await loadRunState(runsDir, runId);
    expect(final?.status).toBe("running");
  });

  it("each runId has an independent lock chain", async () => {
    await bootstrap("r5");
    await bootstrap("r6");
    const order: string[] = [];
    const slow = withRunStateLock(runsDir, "r5", async () => {
      order.push("r5-start");
      await new Promise((res) => setTimeout(res, 30));
      order.push("r5-end");
    });
    const fast = withRunStateLock(runsDir, "r6", async () => {
      order.push("r6-start");
      order.push("r6-end");
    });
    await Promise.all([slow, fast]);
    // r6 completed during r5's critical section — proving independence.
    const r6Start = order.indexOf("r6-start");
    const r5End = order.indexOf("r5-end");
    expect(r6Start).toBeLessThan(r5End);
  });
});
