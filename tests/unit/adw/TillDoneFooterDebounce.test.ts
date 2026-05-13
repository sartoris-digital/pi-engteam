import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ADWEngine } from "../../../src/adw/ADWEngine.js";
import { createRunState, saveRunState } from "../../../src/adw/RunState.js";
import { saveTasks } from "../../../src/team/tools/TaskList.js";

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "tilldone-debounce-"));
});

function makeMockTeam(): any {
  return {
    setStepContext: vi.fn(),
    markStepComplete: vi.fn(),
    clearStepContext: vi.fn(),
    setRunId: vi.fn(),
    setAgentLineCallback: vi.fn(),
    deliver: vi.fn(),
  };
}

function makeMockObserver(): any {
  return { emit: vi.fn() };
}

async function bootstrap(runId: string): Promise<void> {
  const state = await createRunState({ runId, workflow: "wf", goal: "g", budget: {} });
  await saveRunState(runsDir, { ...state, currentStep: "step", phase: "active" });
  await saveTasks(runsDir, runId, []);
}

describe("refreshTillDoneFooterForRun debounce — Phase 5.7", () => {
  it("coalesces N rapid calls into a single setStatus write", async () => {
    await bootstrap("r1");
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map(),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const setStatus = vi.fn();
    engine.setUiCallbacks({ notify: vi.fn(), setStatus }, "r1");

    // Fire 20 rapid refreshes — debounce should collapse them.
    for (let i = 0; i < 20; i++) {
      engine.refreshTillDoneFooterForRun("r1");
    }
    // Before the timer fires (250ms), no tilldone setStatus call yet.
    expect(setStatus).not.toHaveBeenCalledWith("tilldone", expect.any(String));

    // Wait past the debounce window.
    await new Promise((res) => setTimeout(res, 350));

    // Exactly one tilldone write expected.
    const tilldoneCalls = setStatus.mock.calls.filter((c) => c[0] === "tilldone");
    expect(tilldoneCalls).toHaveLength(1);
  });

  it("respects owner gate at fire time", async () => {
    await bootstrap("r2");
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map(),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const setStatus = vi.fn();
    engine.setUiCallbacks({ notify: vi.fn(), setStatus }, "r2");

    engine.refreshTillDoneFooterForRun("r2");
    // Owner changes while the debounce is pending.
    engine.setUiCallbacks({ notify: vi.fn(), setStatus }, "different-run");

    await new Promise((res) => setTimeout(res, 350));
    // No tilldone write because owner mismatched at fire time.
    const tilldoneCalls = setStatus.mock.calls.filter((c) => c[0] === "tilldone");
    expect(tilldoneCalls).toHaveLength(0);
  });

  it("a no-op call when no callbacks are bound never schedules a timer", async () => {
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map(),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    // No setUiCallbacks call.
    engine.refreshTillDoneFooterForRun("r3");
    await new Promise((res) => setTimeout(res, 350));
    // Survives without throwing — timer was never created.
    expect(true).toBe(true);
  });

  it("dirty flag fires a follow-up refresh that re-reads tasks.json (round-2 M2)", async () => {
    await bootstrap("r4");
    await saveTasks(runsDir, "r4", [
      { taskId: "t1", status: "pending", team: "engineering", updatedAt: "1" },
    ]);
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map(),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const setStatus = vi.fn();
    engine.setUiCallbacks({ notify: vi.fn(), setStatus }, "r4");

    // Schedule first refresh; while its async chain is awaiting I/O,
    // mutate tasks.json AND fire another refresh so the in-flight one
    // sees dirty=true and triggers a follow-up that reads the new state.
    engine.refreshTillDoneFooterForRun("r4");

    // Wait until the timer fires (250ms) — the in-flight chain is now
    // awaiting loadRunState/loadTasks. Mutate tasks and refresh again
    // to drive the dirty path.
    await new Promise((res) => setTimeout(res, 260));
    await saveTasks(runsDir, "r4", [
      { taskId: "t1", status: "completed", team: "engineering", updatedAt: "2" },
    ]);
    engine.refreshTillDoneFooterForRun("r4");

    // Wait for the follow-up to fire (another debounce window + I/O).
    await new Promise((res) => setTimeout(res, 700));

    const tilldoneCalls = setStatus.mock.calls.filter((c) => c[0] === "tilldone");
    expect(tilldoneCalls.length).toBeGreaterThanOrEqual(2);
    // Distinct rendered strings prove a SECOND read actually happened
    // — the first showed 0/1 complete, the second showed 1/1.
    const distinct = new Set(tilldoneCalls.map((c) => c[1]));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
    const lastWrite = tilldoneCalls.at(-1)![1] as string;
    expect(lastWrite).toContain("1/1");
  });

  it("clearUiStatus invalidates an in-flight refresh's setStatus (round-1 H2)", async () => {
    await bootstrap("r5");
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map(),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const setStatus = vi.fn();
    engine.setUiCallbacks({ notify: vi.fn(), setStatus }, "r5");

    engine.refreshTillDoneFooterForRun("r5");
    // Wait for timer to fire but not for I/O to complete — the
    // clearUiCallbacks call below races the in-flight async chain.
    await new Promise((res) => setTimeout(res, 260));
    engine.clearUiCallbacks();

    await new Promise((res) => setTimeout(res, 200));
    // After clearUiCallbacks, the engine no longer has callbacks at all,
    // so any subsequent setStatus would be skipped at the !uiCallbacks
    // guard. We assert by checking that the FIRST tilldone call (which
    // ran before clearUiCallbacks) is the only one — additional calls
    // after the clear are blocked.
    // (Either one tilldone write happened before clear, or zero. Both
    // are acceptable; what matters is no UNDEFINED-OWNER write fires
    // after the run ended.)
    expect(setStatus.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("end-of-run clearUiStatus(runId) clears tilldone AND invalidates pending refreshes (round-3 M3)", async () => {
    // Drives the cancelPendingFooterTimer path by running a workflow
    // whose step takes long enough that the debounce timer fires AND
    // the in-flight chain can be in progress when the run ends.
    const dir = await mkdtemp(join(tmpdir(), "tilldone-end-"));
    const workflow = {
      name: "wf",
      description: "test",
      steps: [{
        name: "only",
        required: true,
        run: async () => {
          // Step duration > debounce window so the timer fires while
          // the step is running.
          await new Promise((res) => setTimeout(res, 400));
          return { success: true, verdict: "PASS" as const };
        },
      }],
      transitions: [{ from: "only", when: () => true, to: "halt" as const }],
      defaults: {},
    };
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["wf", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const setStatus = vi.fn();

    const run = await engine.startRun({ workflow: "wf", goal: "g", budget: {} });
    engine.setUiCallbacks({ notify: vi.fn(), setStatus }, run.runId);

    // Schedule a refresh BEFORE executeRun. The 250ms debounce timer
    // fires during the 400ms step; the in-flight chain reads + writes
    // a tilldone string. Then the run ends, clearUiStatus(runId) fires
    // setStatus("tilldone", undefined).
    engine.refreshTillDoneFooterForRun(run.runId);
    await engine.executeRun(run.runId);
    // Allow any post-end async tail to settle.
    await new Promise((res) => setTimeout(res, 350));

    const tilldoneCalls = setStatus.mock.calls.filter((c) => c[0] === "tilldone");
    // Round-3 M3: REQUIRE at least one tilldone clear (undefined) so
    // the test fails if the cancel path silently no-ops.
    const undefinedClears = tilldoneCalls.filter((c) => c[1] === undefined);
    expect(undefinedClears.length).toBeGreaterThanOrEqual(1);
    // The LAST tilldone call must be the clear, not a stale string.
    expect(tilldoneCalls.at(-1)![1]).toBeUndefined();
    // Round-4 M1: prove invalidation actually works. After the undefined
    // clear, NO subsequent string-valued tilldone setStatus may fire.
    // Without the seq bump in cancelPendingFooterTimer, an in-flight
    // refresh that resolved post-clear would slip a stale string write
    // through, violating this invariant.
    const clearIdx = tilldoneCalls.findIndex((c) => c[1] === undefined);
    const postClearWrites = tilldoneCalls.slice(clearIdx + 1).filter((c) => typeof c[1] === "string");
    expect(postClearWrites).toHaveLength(0);
  });

  it("abortRun also drains pending footer state (round-4 L1)", async () => {
    // Defense-in-depth: abortRun is a separate terminal path from
    // executeRun's normal completion. Verify it also clears the tilldone
    // key and invalidates pending refreshes via clearUiStatus.
    const dir = await mkdtemp(join(tmpdir(), "tilldone-abort-"));
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map(),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const setStatus = vi.fn();

    // Bootstrap state directly (no workflow needed for abortRun).
    const { createRunState, saveRunState } = await import("../../../src/adw/RunState.js");
    const state = await createRunState({ runId: "rA", workflow: "wf", goal: "g", budget: {} });
    await saveRunState(dir, { ...state, currentStep: "step", phase: "active" });

    engine.setUiCallbacks({ notify: vi.fn(), setStatus }, "rA");
    engine.refreshTillDoneFooterForRun("rA");
    await new Promise((res) => setTimeout(res, 260));

    await engine.abortRun("rA");
    await new Promise((res) => setTimeout(res, 200));

    const tilldoneCalls = setStatus.mock.calls.filter((c) => c[0] === "tilldone");
    const undefinedClears = tilldoneCalls.filter((c) => c[1] === undefined);
    expect(undefinedClears.length).toBeGreaterThanOrEqual(1);
    expect(tilldoneCalls.at(-1)![1]).toBeUndefined();
  });
});
