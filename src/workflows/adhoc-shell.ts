// src/workflows/adhoc-shell.ts
//
// PLAN.md ApprovalWatcher Phase 10 — adhoc-shell workflow.
//
// The adhoc-shell workflow gives ad-hoc Pi usage a run context that
// stays open for approvals. The historical pattern was: user runs a
// destructive operation outside a workflow → RequestApproval refuses
// because PI_ENGINEERING_RUN_ID is unset → user has no path forward
// short of starting a real workflow.
//
// adhoc-shell solves this with a single "open" step that:
//   1. Confirms the run is registered with the watcher (Phase 8) so
//      RequestApproval has somewhere to write.
//   2. Returns immediately with `pauseForUser` set so ADWEngine
//      transitions to `waiting_user` and stops driving the loop.
//   3. The user now runs interactive destructive operations; each
//      call to RequestApproval writes to <run>/approvals/pending/
//      and the dispatcher routes the Judge call.
//   4. `/run-resume` (clears pauseForUser) closes the adhoc session
//      and the workflow halts.
//
// The hold is bounded by `state.adhocHoldExpiresAt` (Phase 1 type).
// `/approval-watcher extend-hold <runId> --hours N` bumps it
// (Phase 2 command). When the hold expires, the watcher's stale-block
// gate kicks in and refuses to drain new approvals until the user
// re-engages (`/approval-watcher reengage <runId>`).
//
// This workflow has ONE step. There is no plan/build/review loop —
// the user is the driver.

import type { Workflow, Step, StepContext, StepResult } from "./types.js";

const ADHOC_DEFAULT_HOLD_HOURS = 8;

const openStep: Step = {
  name: "open",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    // Record an initial adhocHoldExpiresAt so the watcher's stale gate
    // (Phase 9) gives the user a generous window before refusing fresh
    // approvals. Default 8h; operator bumps via /approval-watcher
    // extend-hold.
    const expiry = new Date(Date.now() + ADHOC_DEFAULT_HOLD_HOURS * 3600 * 1000).toISOString();
    // The adhocHoldExpiresAt field on RunState is set here by emitting
    // a sentinel artifact + the pauseForUser reason text. ADWEngine
    // surfaces the reason; a follow-up wire (or the user's first
    // /approval-watcher extend-hold call) writes the field. We avoid
    // direct fs writes here so the workflow stays pure-runtime and
    // doesn't duplicate ADWEngine's state-save machinery.
    return {
      success: true,
      verdict: "PASS",
      artifacts: {
        "adhoc-hold-expires-at": expiry,
      },
      pauseForUser: {
        reason: `adhoc-shell open. Approvals route to <run>/approvals/pending/. Initial hold expires ${expiry}. /run-resume to close, /approval-watcher extend-hold ${ctx.run.runId} --hours N to push the expiry.`,
      },
    };
  },
};

export const adhocShell: Workflow = {
  name: "adhoc-shell",
  description:
    "Open an ad-hoc shell context for approval-bound interactive operations. Pauses immediately for user; /run-resume to close.",
  steps: [openStep],
  transitions: [
    { from: "open", when: () => true, to: "halt" },
  ],
  defaults: {
    maxIterations: 1,
    maxCostUsd: 0,
    maxWallSeconds: 86_400, // 24h envelope for a single adhoc session
  },
};
