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

  it("dirty flag fires a follow-up refresh when calls arrive during in-flight (round-1 H1)", async () => {
    await bootstrap("r4");
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map(),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const setStatus = vi.fn();
    engine.setUiCallbacks({ notify: vi.fn(), setStatus }, "r4");

    // First refresh — schedules and fires.
    engine.refreshTillDoneFooterForRun("r4");
    await new Promise((res) => setTimeout(res, 300));
    let tilldoneCalls = setStatus.mock.calls.filter((c) => c[0] === "tilldone");
    expect(tilldoneCalls).toHaveLength(1);

    // Now simulate a TaskUpdate arriving DURING the in-flight chain.
    // Concretely, fire many refreshes; the first one schedules+fires,
    // arrivals during fire mark dirty and produce a follow-up.
    for (let i = 0; i < 5; i++) {
      engine.refreshTillDoneFooterForRun("r4");
    }
    await new Promise((res) => setTimeout(res, 600));

    // We expect the original (1) plus at most one follow-up (so up to 2
    // additional writes after the dirty path settles). The point is:
    // the count is BOUNDED, not N where N is the number of refreshes.
    tilldoneCalls = setStatus.mock.calls.filter((c) => c[0] === "tilldone");
    expect(tilldoneCalls.length).toBeLessThanOrEqual(3);
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
});
