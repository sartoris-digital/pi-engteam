import type { RunState, BudgetStatus, VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "../workflows/types.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { Observer } from "../observer/Observer.js";
import {
  createRunState,
  saveRunState,
  loadRunState,
  updateStep,
  withRunStateLock,
} from "./RunState.js";
import { checkBudget, tickBudget } from "./BudgetGuard.js";
import { writeActiveRun } from "./ActiveRun.js";
import { runVerifyLoop, VerifyExhaustedError } from "../verifier/VerifierLoop.js";
import { resolveDag, validateWorkflow } from "./DagResolver.js";
import { mkdir, appendFile } from "fs/promises";
import { join as joinPath } from "path";
import { loadTasks } from "../team/tools/TaskList.js";
import { formatTillDoneFooter } from "./TillDoneFooter.js";
import { buildRuntimeFingerprint, makeCapabilityMatrix, performCapabilityCheck, defaultStepTimeoutSeconds, runWithStepTimeout, StepTimeoutError } from "../team/phaseA-runtime.js";

// Phase 5.7 round-1 H1/H2/H3: per-runId footer refresh tracking. Each
// pending entry tracks: the debounce timer (cleared/replaced when a new
// refresh arrives in the debounce window), an in-flight flag set when
// the timer fires and reads/writes start, a dirty flag set by refreshes
// arriving WHILE in-flight (triggers a follow-up refresh on settle),
// and a gen counter bumped by clearUiStatus or new schedules to
// invalidate any in-flight refresh that hasn't reached setStatus yet.
type FooterRefreshEntry = {
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  dirty: boolean;
  gen: number;
};

type ADWConfig = {
  runsDir: string;
  workflows: Map<string, Workflow>;
  team: TeamRuntime;
  observer: Observer;
  /**
   * Phase 6 round-2 H2: optional fallback that runs when the engine
   * encounters a runId whose workflow is not in the in-memory registry
   * (e.g., after a process restart for a /consult run whose ephemeral
   * `consult-<random>` name didn't survive). The resolver receives the
   * persisted RunState and may return a freshly-built Workflow which
   * is then registered. Returning undefined preserves the existing
   * "Workflow not found" error.
   */
  resolveMissingWorkflow?: (state: RunState) => Workflow | undefined;
};

type StartRunParams = {
  workflow: string;
  goal: string;
  budget: Parameters<typeof createRunState>[0]["budget"];
  initialArtifacts?: string[];
  /**
   * Phase 6 round-4 H4: optional metadata persisted in the initial
   * state.json write so a crash between startRun and any follow-up
   * save() can't leave the run with missing resume info. Used by
   * /consult to atomically persist consultTeams + rounds.max.
   */
  initialMetadata?: { rounds?: { current: number; max: number }; consultTeams?: string[] };
};

type UiCallbacks = {
  notify: (msg: string, type?: "info" | "warning" | "error") => void;
  setStatus: (key: string, text: string | undefined) => void;
};

export class ADWEngine {
  private uiCallbacks?: UiCallbacks;
  // Phase 5.6 round-3 M1: track which runId owns the current callbacks so
  // a finishing run doesn't clear another concurrently-active run's
  // status. Callbacks are scoped to a single run; the most recent
  // setUiCallbacks wins, but clearUiStatus only clears when the current
  // run is the owner.
  private uiCallbacksOwner?: string;

  constructor(private config: ADWConfig) {
    for (const wf of config.workflows.values()) {
      validateWorkflow(wf);
    }
  }

  /** Phase 4: expose the runs directory so workflow steps can locate <run>/conversation.jsonl. */
  getRunsDir(): string {
    return this.config.runsDir;
  }

  /** Phase 4: register a new workflow at runtime; validates DAG / cycles. */
  registerWorkflow(wf: Workflow): void {
    validateWorkflow(wf);
    this.config.workflows.set(wf.name, wf);
  }

  private isDagWorkflow(wf: Workflow): boolean {
    return wf.steps.some((s) => Array.isArray(s.dependsOn));
  }

  /**
   * Attach Pi UI callbacks so the engine can surface step progress in the TUI.
   * Round-3 M1: the optional runId binds these callbacks to a specific run
   * so concurrent shortcut-triggered runs don't clear each other's status.
   * If no runId is supplied, the previous behavior (last-write-wins, no
   * ownership tracking) is preserved.
   */
  setUiCallbacks(cbs: UiCallbacks, runId?: string): void {
    this.uiCallbacks = cbs;
    this.uiCallbacksOwner = runId;
  }

  /** Detach UI callbacks (called at run end or when context is no longer valid). */
  clearUiCallbacks(): void {
    this.uiCallbacks = undefined;
    this.uiCallbacksOwner = undefined;
  }

  // Phase 5.6 round-1 H1: monotonic sequence so a stale async footer
  // refresh (one that started earlier but completed later) doesn't
  // overwrite a newer setStatus or a clear. Each refresh captures the
  // current seq value at start; if the seq has advanced or
  // clearUiStatus has been called by the time loadTasks resolves, the
  // setStatus is skipped.
  private footerRefreshSeq = 0;

  // Phase 5.7: per-runId debounce + in-flight tracking for
  // refreshTillDoneFooterForRun. A bursty worker emitting many
  // TaskUpdates inside one step would otherwise trigger N concurrent
  // loadRunState + loadTasks reads.
  //
  // Round-1 H1/H2/H3 (Phase 5.7): the entry persists across the entire
  // load+save async chain so:
  //   - A new refresh during the in-flight window doesn't kick off a
  //     parallel read; instead it sets the `dirty` flag, and a follow-up
  //     refresh fires once the in-flight one settles.
  //   - clearUiStatus can bump the entry's `gen` to invalidate the
  //     in-flight refresh before it reaches setStatus.
  //   - Owner rebinds during loadTasks are detected by re-checking
  //     uiCallbacksOwner against state.runId AFTER each await.
  private pendingFooterTimers = new Map<string, FooterRefreshEntry>();
  private static readonly FOOTER_DEBOUNCE_MS = 250;

  private clearUiStatus(runId?: string): void {
    // Round-3 M1: only clear if the current callback owner matches the
    // ending run, OR if no owner is recorded (legacy behavior). When
    // shortcut-triggered runs A and B race, B's setUiCallbacks replaces
    // A's; A's clearUiStatus call must NOT erase B's status.
    if (runId && this.uiCallbacksOwner && runId !== this.uiCallbacksOwner) {
      // Still bump seq so an in-flight refresh from this run's
      // refreshTillDoneFooter doesn't write a stale value, but don't
      // touch the new owner's status keys.
      this.footerRefreshSeq++;
      // Phase 5.7: also cancel any pending debounced refresh for THIS
      // ending run so it doesn't fire after we've decided to step away.
      if (runId) this.cancelPendingFooterTimer(runId);
      return;
    }
    this.uiCallbacks?.setStatus("engineering", undefined);
    this.uiCallbacks?.setStatus("engineering_out", undefined);
    this.uiCallbacks?.setStatus("tilldone", undefined);
    // Bump seq so any in-flight refreshes see a stale token and bail.
    this.footerRefreshSeq++;
    // Phase 5.7: cancel any pending debounced refresh — the run is over.
    if (runId) {
      this.cancelPendingFooterTimer(runId);
    } else {
      // No specific runId: legacy callers; cancel ALL pending timers
      // and invalidate any in-flight refreshes.
      for (const e of this.pendingFooterTimers.values()) {
        if (e.timer) clearTimeout(e.timer);
        e.timer = undefined;
        e.dirty = false;
        e.gen++;
      }
      // Drop entries that aren't in-flight; in-flight ones self-clean
      // when their async chain reaches the finally block.
      for (const [k, e] of [...this.pendingFooterTimers.entries()]) {
        if (!e.inFlight) this.pendingFooterTimers.delete(k);
      }
    }
    this.config.team.setAgentLineCallback?.(undefined);
  }

  private cancelPendingFooterTimer(runId: string): void {
    const entry = this.pendingFooterTimers.get(runId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    // Bump gen AND footerRefreshSeq so any in-flight async chain bails
    // before setStatus. footerRefreshSeq is what refreshTillDoneFooter
    // checks after loadTasks; entry.gen is what runDebouncedFooterRefresh
    // checks before delegating to refreshTillDoneFooter. Both must
    // advance to fully invalidate (round-3 M1).
    entry.gen++;
    this.footerRefreshSeq++;
    entry.dirty = false;
    entry.timer = undefined;
    if (!entry.inFlight) {
      // No async chain to invalidate; safe to drop the entry now.
      this.pendingFooterTimers.delete(runId);
    }
  }

  /**
   * Phase 5.6 round-2 H2 + round-4 H1 + Phase 5.7: public debounced hook
   * for triggering a footer refresh outside of step boundaries (e.g.,
   * from src/index.ts onSubprocessEvent on each TaskUpdate audit line).
   *
   * Round-1 H1/H2/H3 (Phase 5.7):
   * - If a refresh is already in flight for this runId, set the dirty
   *   flag and return. The in-flight handler will fire a follow-up
   *   refresh on settle to capture the latest tasks.json state.
   * - Each new schedule bumps `gen` to invalidate any prior in-flight
   *   refresh that hasn't reached setStatus yet.
   * - The handler re-checks owner AND callback presence after each
   *   await, before writing setStatus.
   *
   * Best-effort throughout: missing state/tasks/callbacks silently no-op.
   */
  refreshTillDoneFooterForRun(runId: string): void {
    if (!this.uiCallbacks) return;
    if (this.uiCallbacksOwner && this.uiCallbacksOwner !== runId) return;

    let entry = this.pendingFooterTimers.get(runId);
    if (!entry) {
      entry = { inFlight: false, dirty: false, gen: 0 };
      this.pendingFooterTimers.set(runId, entry);
    }
    // If something is already in flight, just mark dirty — the handler
    // will fire one final refresh after it settles. Bump gen so any
    // older in-flight chain that might race the follow-up is invalidated
    // at the setStatus point.
    //
    // Round-3 M1: also bump footerRefreshSeq. refreshTillDoneFooter
    // compares its captured myToken to footerRefreshSeq AFTER loadTasks,
    // before setStatus. Without this bump, a stale in-flight chain
    // could complete its write between the gen check and the setStatus.
    if (entry.inFlight) {
      entry.dirty = true;
      entry.gen++;
      this.footerRefreshSeq++;
      return;
    }
    // Clear any pending pre-fire timer and reschedule.
    if (entry.timer) clearTimeout(entry.timer);
    entry.gen++;
    const myEntry = entry;
    const timer = setTimeout(() => {
      void this.runDebouncedFooterRefresh(runId, myEntry);
    }, ADWEngine.FOOTER_DEBOUNCE_MS);
    timer.unref?.();
    entry.timer = timer;
  }

  private async runDebouncedFooterRefresh(runId: string, entry: FooterRefreshEntry): Promise<void> {
    entry.timer = undefined;
    entry.inFlight = true;
    const myGen = entry.gen;
    try {
      // Re-check owner + callbacks at every await point so a clear or
      // owner rebind during the read chain stops the eventual write.
      if (!this.uiCallbacks) return;
      if (this.uiCallbacksOwner && this.uiCallbacksOwner !== runId) return;
      const state = await loadRunState(this.config.runsDir, runId).catch(() => null);
      if (!state) return;
      if (myGen !== entry.gen) return; // invalidated during loadRunState
      if (!this.uiCallbacks) return;
      if (this.uiCallbacksOwner && this.uiCallbacksOwner !== runId) return;
      await this.refreshTillDoneFooter(state);
      // refreshTillDoneFooter does its own owner+seq check before setStatus.
    } finally {
      entry.inFlight = false;
      // If a refresh arrived during in-flight, fire a follow-up so the
      // latest tasks.json state is reflected.
      if (entry.dirty) {
        entry.dirty = false;
        // Schedule via the public path so debounce + owner gate apply.
        this.refreshTillDoneFooterForRun(runId);
      }
      // Round-2 M1: drop the map entry whenever no further work is
      // queued — covers BOTH the no-dirty path AND the dirty path that
      // bailed out of refreshTillDoneFooterForRun (no callbacks, owner
      // mismatch). Without this, long-lived processes accumulate stale
      // per-run entries with no scheduled work.
      const current = this.pendingFooterTimers.get(runId);
      if (current === entry && !current.timer && !current.inFlight && !current.dirty) {
        this.pendingFooterTimers.delete(runId);
      }
    }
  }

  /**
   * Phase 5.6 §9.2: refresh the Pi TUI footer widget showing TillDone
   * task progress alongside agent activity. Best-effort — a missing
   * tasks.json or callback is silently a no-op.
   *
   * Round-4 H1: owner-gated. If the UI callbacks were re-bound to a
   * newer run while this refresh was queued (or via a stale step-
   * boundary call from an aborted run), don't write to the new run's
   * status keys.
   */
  private async refreshTillDoneFooter(state: RunState): Promise<void> {
    if (!this.uiCallbacks) return;
    if (this.uiCallbacksOwner && this.uiCallbacksOwner !== state.runId) return;
    const myToken = ++this.footerRefreshSeq;
    try {
      const tasks = await loadTasks(this.config.runsDir, state.runId);
      // Round-1 H1: drop stale refresh writes. If a later refresh OR a
      // clear has bumped the seq while we were awaiting loadTasks, our
      // setStatus would be incorrect.
      if (myToken !== this.footerRefreshSeq) return;
      // Phase 5.7 round-1 H3: re-check owner AND callbacks AFTER each
      // await. setUiCallbacks may have rebound to a different run during
      // the loadTasks read; we must NOT write to the new owner's status.
      if (!this.uiCallbacks) return;
      if (this.uiCallbacksOwner && this.uiCallbacksOwner !== state.runId) return;
      const text = formatTillDoneFooter({
        workflow: state.workflow,
        goal: state.goal,
        tasks,
      });
      this.uiCallbacks.setStatus("tilldone", text);
    } catch {
      /* best-effort */
    }
  }

  async startRun(params: StartRunParams): Promise<RunState> {
    const runId = crypto.randomUUID();
    const workflow = this.config.workflows.get(params.workflow);
    if (!workflow) throw new Error(`Workflow '${params.workflow}' not found`);

    // Phase A item 1: capability gate at run start. In `observe`/`warn`
    // mode this logs warnings and proceeds; in `enforce` mode a missing
    // / wildcard-only / stale bundle refuses the run with a clear
    // `provider-missing-capability` error. Legacy mode bypasses
    // entirely.
    try {
      const matrix = makeCapabilityMatrix();
      const fp = buildRuntimeFingerprint({});
      const cap = performCapabilityCheck(matrix, fp);
      if (!cap.allowed) {
        throw new Error(cap.reason);
      }
    } catch (err) {
      // Re-throw provider-missing-capability errors so the operator
      // sees them immediately; swallow ENOENT/permission errors from
      // a missing capabilities dir on first install so a fresh
      // checkout doesn't refuse to run before the operator has
      // probed.
      if (err instanceof Error && /provider-missing-capability/.test(err.message)) {
        throw err;
      }
    }

    // Codex round-4 MEDIUM: workflow.defaults (e.g. triage's $5/600s) was
    // dead code — startRun only consulted params.budget so every workflow
    // landed on the global default ($20/3600s). Merge: workflow defaults
    // override the global RunState default, then params.budget overrides
    // the workflow defaults. This preserves caller-supplied tuning while
    // letting per-workflow budgets actually take effect.
    const mergedBudget = { ...workflow.defaults, ...params.budget };
    let state = await createRunState({
      runId,
      workflow: params.workflow,
      goal: params.goal,
      budget: mergedBudget,
    });
    state = { ...state, currentStep: workflow.steps[0].name, phase: "active" };
    // Phase 6 round-4 H4: fold initialMetadata into the FIRST state
    // write so a crash before any follow-up save() can't leave the run
    // unresumable. /consult passes consultTeams + rounds atomically.
    if (params.initialMetadata) {
      if (params.initialMetadata.rounds) {
        state = { ...state, rounds: params.initialMetadata.rounds };
      }
      if (params.initialMetadata.consultTeams) {
        state = { ...state, consultTeams: params.initialMetadata.consultTeams } as RunState;
      }
    }
    await saveRunState(this.config.runsDir, state);

    // Codex round-13 HIGH: writeFile on active-run.txt truncated the file
    // before writing new content, so a reader landing in the truncate
    // window saw empty content. SafetyGuard's findValidApproval and
    // loadRunPlanMode then short-circuited on empty runId, bypassing
    // plan-mode for that call. Write to .tmp, then atomic rename — the
    // reader either sees the old runId or the new one, never an empty
    // string.
    const { writeFile, rename } = await import("fs/promises");
    const { join, basename, extname } = await import("path");
    const activeFile = join(this.config.runsDir, "active-run.txt");
    const tmpActive = activeFile + ".tmp";
    await writeFile(tmpActive, runId);
    await rename(tmpActive, activeFile);

    if (params.initialArtifacts?.length) {
      for (const filePath of params.initialArtifacts) {
        const key = basename(filePath, extname(filePath));
        state = { ...state, artifacts: { ...state.artifacts, [key]: filePath } };
      }
      await saveRunState(this.config.runsDir, state);
    }

    this.config.observer.emit({
      runId,
      category: "lifecycle",
      type: "run.start",
      payload: { workflow: params.workflow, goal: params.goal },
      summary: `Run ${runId} started: ${params.goal}`,
    });

    // Phase 4.5 round-1 M-1: spec §9.1 includes user requests in the
    // projection. Emit a host-trusted kind=request entry capturing the
    // user-supplied goal so consult Leads / synthesis read it as the
    // first dialogue turn. opts.host=true is the in-memory marker the
    // projection trusts (vs a forgeable payload field — round-2 C1).
    this.config.observer.emit(
      {
        runId,
        category: "message",
        type: "request",
        payload: {
          from: "user",
          to: "orchestrator",
          text: params.goal,
        },
        summary: params.goal,
      },
      { host: true },
    );

    return state;
  }

  async executeRun(runId: string): Promise<RunState> {
    let state = await loadRunState(this.config.runsDir, runId);
    if (!state) throw new Error(`Run ${runId} not found`);

    // C3: guard against re-executing runs that are already in a terminal state
    const terminalStatuses = ["succeeded", "failed", "aborted"] as const;
    if (terminalStatuses.includes(state.status as any)) {
      return state;
    }

    this.config.team.setRunId(runId);
    state = { ...state, status: "running" };
    await saveRunState(this.config.runsDir, state);

    let workflow = this.config.workflows.get(state.workflow);
    if (!workflow && this.config.resolveMissingWorkflow) {
      // Phase 6 round-2 H2: rebuild ephemeral workflows (e.g., consult)
      // from persisted RunState after a process restart. The resolver
      // gets the full state including consultTeams + rounds.max.
      const rebuilt = this.config.resolveMissingWorkflow(state);
      if (rebuilt) {
        this.registerWorkflow(rebuilt);
        workflow = rebuilt;
      }
    }
    if (!workflow) throw new Error(`Workflow '${state.workflow}' not found`);

    if (this.isDagWorkflow(workflow)) {
      return this.executeDagRun(runId, state, workflow);
    }

    while (state.status === "running") {
      const fresh = await loadRunState(this.config.runsDir, runId);
      if (fresh?.phase === "cancelling" || fresh?.phase === "cancelled") {
        state = { ...state, status: "aborted", phase: "cancelled" };
        await saveRunState(this.config.runsDir, state);
        this.config.observer.emit({
          runId,
          category: "lifecycle",
          type: "run.cancelled",
          payload: { step: state.currentStep },
          summary: `Run ${runId} cancelled at step ${state.currentStep}`,
        });
        break;
      }
      const { maxIterations } = state.budget;
      // maxIterations === 0 means "zero iterations allowed" (exhausted immediately)
      const zeroIterBudget = maxIterations === 0;
      const budgetStatus = zeroIterBudget
        ? { ok: false, warnings: [] as BudgetStatus["warnings"], exhausted: ["iterations" as const] as BudgetStatus["exhausted"] }
        : checkBudget(state);
      if (!budgetStatus.ok) {
        state = { ...state, status: "failed" };
        this.config.observer.emit({
          runId,
          category: "budget",
          type: "exhausted",
          payload: { exhausted: budgetStatus.exhausted },
          summary: `Budget exhausted: ${budgetStatus.exhausted.join(", ")}`,
        });
        break;
      }

      const currentStep = state.currentStep;
      const stepDef = workflow.steps.find(s => s.name === currentStep);
      if (!stepDef) {
        state = { ...state, status: "failed" };
        break;
      }

      this.config.observer.emit({
        runId,
        step: currentStep,
        iteration: state.iteration,
        category: "lifecycle",
        type: "step.start",
        payload: { step: currentStep },
      });

      // Surface step progress to Pi TUI
      const stepIndex = workflow.steps.findIndex(s => s.name === currentStep);
      const totalSteps = workflow.steps.length;
      this.uiCallbacks?.notify(`▶ Step ${stepIndex + 1}/${totalSteps} — ${currentStep}`, "info");
      this.uiCallbacks?.setStatus("engineering", `▶ ${currentStep} (${stepIndex + 1}/${totalSteps})`);
      // Phase 5.6 §9.2: refresh TillDone footer at each step boundary so
      // task progress (per team) is visible alongside agent activity.
      void this.refreshTillDoneFooter(state);
      this.config.team.setAgentLineCallback?.((agent, line) => {
        this.uiCallbacks?.setStatus("engineering_out", `${agent}: ${line.slice(0, 120)}`);
      });

      // Apply step-level planMode override before the step runs
      if (stepDef.planMode !== undefined && state.planMode !== stepDef.planMode) {
        state = { ...state, planMode: stepDef.planMode };
        await saveRunState(this.config.runsDir, state);
      }

      const startedAt = new Date().toISOString();
      state = updateStep(state, state.currentStep, { startedAt });

      // Codex round-8 MEDIUM: use monotonic clock for elapsed-time
      // calculation. Date.now() can go backward under NTP correction or
      // suspend/resume, which would reduce spent.wallSeconds via tickBudget.
      // performance.now() is monotonic and immune to wall-clock jumps.
      const stepStart = performance.now();
      this.config.team.setStepContext(
        state.currentStep,
        workflow.steps.map(s => s.name),
      );
      let result: StepResult;

      try {
        const ctx: StepContext = {
          run: state,
          team: this.config.team,
          observer: this.config.observer,
          engine: this,
        };
        const timeoutSeconds = stepDef.timeoutSeconds ?? defaultStepTimeoutSeconds(stepDef.name);
        result = await runWithStepTimeout(stepDef.name, timeoutSeconds, () => stepDef.run(ctx));
      } catch (err) {
        if (err instanceof StepTimeoutError) {
          result = {
            success: false,
            verdict: "FAIL",
            error: err.message,
            issues: [
              `Step '${err.stepName}' timed out after ${err.elapsedMs}ms (budget ${err.budgetMs}ms). The agent did not emit a verdict within the step's allotted wall-clock budget.`,
            ],
          };
        } else {
          result = {
            success: false,
            verdict: "FAIL",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      } finally {
        this.config.team.markStepComplete(state.currentStep);
      }

      const elapsed = Math.max(0, (performance.now() - stepStart) / 1000);
      state = tickBudget(state, elapsed, {
        costUsd: (result as any).costUsd,
        tokens: (result as any).tokens,
      });
      // M1: use spread to stay consistent with the immutable state update pattern
      if (result.artifacts) {
        state = { ...state, artifacts: { ...state.artifacts, ...result.artifacts } };
      }
      state = updateStep(state, state.currentStep, {
        verdict: result.verdict,
        issues: result.issues,
        handoffHint: result.handoffHint,
        artifacts: result.artifacts ? Object.values(result.artifacts) : undefined,
        endedAt: new Date().toISOString(),
        error: result.error,
      });

      this.config.observer.emit({
        runId,
        step: state.currentStep,
        iteration: state.iteration,
        category: "lifecycle",
        type: "step.end",
        payload: { verdict: result.verdict, issues: result.issues, error: result.error },
      });

      // Update step status in Pi TUI
      const tick = result.verdict === "PASS" ? "✓" : "✗";
      this.uiCallbacks?.setStatus("engineering", `${tick} ${state.currentStep} · ${result.verdict}`);
      this.uiCallbacks?.setStatus("engineering_out", undefined);
      this.config.team.setAgentLineCallback?.(undefined);
      if (result.verdict !== "PASS") {
        const detail = result.issues?.slice(0, 2).join("; ") ?? result.error ?? "";
        this.uiCallbacks?.notify(
          `✗ ${state.currentStep}: FAIL${detail ? ` — ${detail.slice(0, 140)}` : ""}`,
          "warning",
        );
      }

      // Phase 3: Verifier loop. Runs after a worker step PASS when the step
      // declares verify: true. On verifier FAIL/exhaustion, the run pauses for
      // user intervention and we surface the issues in state.json for /run-status.
      if (
        stepDef.verify === true &&
        stepDef.agent &&
        result.verdict === "PASS" &&
        result.success
      ) {
        const verdictPayload: VerdictPayload = {
          step: state.currentStep,
          verdict: result.verdict,
          issues: result.issues,
          artifacts: result.artifacts ? Object.values(result.artifacts) : undefined,
          handoffHint: result.handoffHint,
        };
        const verifyRunId = state.runId;
        const runDir = joinPath(this.config.runsDir, verifyRunId);
        try {
          const verifyResult = await runVerifyLoop({
            team: this.config.team,
            verifierAgentName: "verifier",
            workerAgentName: stepDef.agent,
            workerStep: stepDef.name,
            workerVerdict: verdictPayload,
            runId: verifyRunId,
            runDir,
            maxVerifyLoops: stepDef.maxVerifyLoops ?? 3,
            onPartialGap: async (gap) => {
              try {
                const learningDir = joinPath(runDir, "learning");
                await mkdir(learningDir, { recursive: true });
                await appendFile(
                  joinPath(learningDir, "gaps.jsonl"),
                  JSON.stringify({ ...gap, runId: verifyRunId, ts: new Date().toISOString() }) + "\n",
                );
              } catch { /* best-effort */ }
            },
            // Phase 4.5 round-1 H-3 + round-2 M-2: surface the verifier's
            // corrective turn in the dialogue projection. Use emitAwaited
            // so the projection write completes BEFORE the corrective
            // team.deliver below — preserves dialogue ordering. opts.host
            // is the in-memory trust marker (round-2 C1).
            onCorrection: ((iter) => async (entry) => {
              await this.config.observer.emitAwaited(
                {
                  runId: verifyRunId,
                  step: entry.workerStep,
                  iteration: iter,
                  agentName: "verifier",
                  category: "message",
                  type: "correction",
                  payload: {
                    from: "verifier",
                    to: entry.workerAgentName,
                    text: `Re-iterate ${entry.workerStep} (attempt ${entry.iteration + 1}). Issues: ${entry.issues.join("; ") || "(none)"}`,
                    ref: entry.reportPath,
                  },
                  summary: `verifier requests re-iteration on ${entry.workerStep}`,
                },
                { host: true },
              );
            })(state.iteration),
          });

          this.config.observer.emit({
            runId,
            step: state.currentStep,
            iteration: state.iteration,
            category: "verdict",
            type: "verify",
            payload: {
              verdict: verifyResult.verdict,
              confidence: verifyResult.confidence,
              issues: verifyResult.issues,
              report: verifyResult.report,
            },
            summary: `verifier ${verifyResult.verdict} on ${state.currentStep}`,
          });
        } catch (err) {
          if (err instanceof VerifyExhaustedError) {
            state = updateStep(state, state.currentStep, {
              verdict: "FAIL",
              issues: err.lastIssues,
              error: err.message,
            });
            state = { ...state, status: "waiting_user" };
            await saveRunState(this.config.runsDir, state);
            this.config.observer.emit({
              runId,
              step: state.currentStep,
              iteration: state.iteration,
              category: "verdict",
              type: "verify_exhausted",
              payload: { issues: err.lastIssues, attempts: err.attempts },
              summary: `verifier exhausted on ${state.currentStep}`,
            });
            this.uiCallbacks?.notify(
              `⏸ Verifier exhausted on ${state.currentStep} after ${err.attempts} loop(s). Run paused.`,
              "warning",
            );
            this.uiCallbacks?.setStatus("engineering", `⏸ verifier exhausted (${state.currentStep})`);
            break;
          }
          throw err;
        }
      }

      const transition = workflow.transitions.find(
        t => t.from === state!.currentStep && t.when(result),
      );

      if (!transition || transition.to === "halt") {
        state = { ...state, status: result.success ? "succeeded" : "failed" };
        break;
      }

      state = {
        ...state,
        currentStep: transition.to,
        iteration: state.iteration + 1,
      };

      // Phase 4 + round-4 C-1: pick up any external phase mutation
      // (e.g., /run-cancel) before saving, under the per-runId mutex so the
      // load and save are atomic with respect to /run-cancel's own write.
      {
        const snap: RunState = state;
        state = await withRunStateLock<RunState>(this.config.runsDir, runId, async () => {
          const phaseFresh = await loadRunState(this.config.runsDir, runId);
          const merged: RunState = phaseFresh?.phase ? { ...snap, phase: phaseFresh.phase } : snap;
          await saveRunState(this.config.runsDir, merged);
          return merged;
        });
      }

      // Phase 10 (PLAN.md item 17): runtime pause-for-user via
      // StepResult.pauseForUser. The step can request a pause at any
      // verdict — typically used by the adhoc-shell workflow where the
      // step opens an interactive context and waits for the user to
      // drive approvals. ADWEngine records the reason and transitions
      // to waiting_user without breaking the loop (the dispatcher /
      // watcher continues serving approvals for the run).
      if (result.pauseForUser && typeof result.pauseForUser.reason === "string") {
        state = {
          ...state,
          status: "waiting_user",
          pauseForUser: { reason: result.pauseForUser.reason },
        };
        const pauseSnap = state;
        await withRunStateLock(this.config.runsDir, runId, async () => {
          await saveRunState(this.config.runsDir, pauseSnap);
        });
        this.config.observer.emit({
          runId,
          step: state.currentStep,
          iteration: state.iteration,
          category: "verdict",
          type: "pause_for_user",
          payload: { reason: result.pauseForUser.reason },
          summary: `Run paused for user: ${result.pauseForUser.reason}`,
        });
        this.uiCallbacks?.notify(
          `⏸ Run paused: ${result.pauseForUser.reason}. /run-resume when ready (use /approval-watcher extend-hold to push the stale-block expiry).`,
          "info",
        );
        this.uiCallbacks?.setStatus("engineering", `⏸ ${result.pauseForUser.reason}`);
        break;
      }

      // Pause if the completed step requested it
      if (stepDef.pauseAfter && result.verdict === "PASS") {
        state = { ...state, status: "waiting_user" };
        await writeActiveRun({
          runId,
          phase: stepDef.pauseAfter,
          stepName: stepDef.name,
          runsDir: this.config.runsDir,
        });
        const pauseSnap: RunState = state;
        await withRunStateLock(this.config.runsDir, runId, async () => {
          await saveRunState(this.config.runsDir, pauseSnap);
        });

        // C1: surface clear pause instructions in the TUI for workflows started via /run-start
        const pauseMessage = stepDef.pauseAfter === "answering"
          ? [
              `questions written → ${this.config.runsDir}/${runId}/questions.md`,
              "",
              "Reply in chat with your discovery answers in a single message and I'll save them to answers.md and continue.",
              `Or write ${this.config.runsDir}/${runId}/answers.md manually, then run /run-resume ${runId}.`,
            ].join("\n")
          : [
              `step ready for approval → ${stepDef.name}`,
              "",
              'Type "approve" when you are ready to continue.',
            ].join("\n");
        this.uiCallbacks?.notify(pauseMessage, "info");
        this.uiCallbacks?.setStatus("engineering", `⏸ waiting for user (${stepDef.pauseAfter})`);
        break;
      }
    }

    // Round-4 C-1: linear terminal save under per-runId mutex; reload phase
    // from disk so a /run-cancel arriving in the closing window is honored.
    const stateBeforeTerminal: RunState = state;
    state = await withRunStateLock<RunState>(this.config.runsDir, runId, async () => {
      const finalFresh = await loadRunState(this.config.runsDir, runId);
      const terminal: RunState = finalFresh?.phase === "cancelling" || finalFresh?.phase === "cancelled"
        ? { ...stateBeforeTerminal, status: "aborted", phase: "cancelled" }
        : stateBeforeTerminal;
      await saveRunState(this.config.runsDir, terminal);
      return terminal;
    });

    this.clearUiStatus(runId);

    this.config.observer.emit({
      runId,
      category: "lifecycle",
      type: "run.end",
      payload: { status: state.status, iteration: state.iteration },
      summary: `Run ${runId} ended: ${state.status}`,
    });

    return state;
  }

  /**
   * Phase 4: DAG-based execution. Runs steps level by level. Within a level,
   * parallel steps fan out via Promise.allSettled (one failure does not abort
   * siblings); sequential steps run after, in declaration order. The run
   * succeeds iff every step ends with PASS. Cancellation is honored at each
   * level boundary.
   */
  private async executeDagRun(
    runId: string,
    initial: RunState,
    workflow: Workflow,
  ): Promise<RunState> {
    let state = initial;
    let levels;
    try {
      levels = resolveDag(workflow);
    } catch (err) {
      state = { ...state, status: "failed" };
      await saveRunState(this.config.runsDir, state);
      throw err;
    }

    let aborted = false;
    let anyFail = false;

    for (const level of levels) {
      const fresh = await loadRunState(this.config.runsDir, runId);
      if (fresh?.phase === "cancelling" || fresh?.phase === "cancelled") {
        state = { ...state, status: "aborted", phase: "cancelled" };
        await saveRunState(this.config.runsDir, state);
        this.config.observer.emit({
          runId,
          category: "lifecycle",
          type: "run.cancelled",
          payload: { step: state.currentStep },
          summary: `Run ${runId} cancelled before level`,
        });
        aborted = true;
        break;
      }
      // H5: enforce budget at every DAG level boundary, mirroring linear semantics.
      const { maxIterations } = state.budget;
      const zeroIterBudget = maxIterations === 0;
      const budgetStatus = zeroIterBudget
        ? { ok: false, warnings: [] as BudgetStatus["warnings"], exhausted: ["iterations" as const] as BudgetStatus["exhausted"] }
        : checkBudget(state);
      if (!budgetStatus.ok) {
        state = { ...state, status: "failed", phase: "failed" };
        await saveRunState(this.config.runsDir, state);
        this.config.observer.emit({
          runId,
          category: "budget",
          type: "exhausted",
          payload: { exhausted: budgetStatus.exhausted },
          summary: `Budget exhausted: ${budgetStatus.exhausted.join(", ")}`,
        });
        aborted = true;
        break;
      }

      // Codex round-2 H-1: increment iteration per DAG level so checkBudget's
      // Phase 6 round-3 H1: on resume, skip steps that already have a
      // PASS verdict in RunState.steps. Non-PASS (FAIL/NEEDS_MORE) and
      // unrun steps re-execute.
      // Phase 6 round-4 H2: derive the runnable set BEFORE incrementing
      // iteration. A fully-skipped level (all parallel + sequential
      // already PASSed) was previously burning a budget tick on resume,
      // which could trip maxIterations before the remaining work ran.
      const passedNames = new Set(
        state.steps.filter((r) => r.verdict === "PASS").map((r) => r.name),
      );
      const parallelToRun = level.parallel.filter((s) => !passedNames.has(s.name));
      const sequentialToRun = level.sequential.filter((s) => !passedNames.has(s.name));
      if (parallelToRun.length === 0 && sequentialToRun.length === 0) {
        // Nothing to do at this level — don't tick iteration/budget.
        continue;
      }
      state = { ...state, iteration: state.iteration + 1 };
      const parallelResults = await Promise.allSettled(
        parallelToRun.map((s) => this.runDagStep(runId, state, workflow, s)),
      );
      for (let i = 0; i < parallelResults.length; i++) {
        const step = parallelToRun[i];
        const r = parallelResults[i];
        const result: StepResult = r.status === "fulfilled"
          ? r.value.result
          : { success: false, verdict: "FAIL", error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
        const elapsed = r.status === "fulfilled" ? r.value.elapsed : 0;
        const startedAt = r.status === "fulfilled" ? r.value.startedAt : undefined;
        state = await this.applyStepResult(runId, state, step, result, elapsed, startedAt);
        if (result.verdict !== "PASS") anyFail = true;
      }

      for (const step of sequentialToRun) {
        const fresh2 = await loadRunState(this.config.runsDir, runId);
        if (fresh2?.phase === "cancelling" || fresh2?.phase === "cancelled") {
          state = { ...state, status: "aborted", phase: "cancelled" };
          await saveRunState(this.config.runsDir, state);
          aborted = true;
          break;
        }
        let result: StepResult;
        let elapsed = 0;
        let startedAt: string | undefined;
        try {
          const out = await this.runDagStep(runId, state, workflow, step);
          result = out.result;
          elapsed = out.elapsed;
          startedAt = out.startedAt;
        } catch (err) {
          result = {
            success: false,
            verdict: "FAIL",
            error: err instanceof Error ? err.message : String(err),
          };
        }
        state = await this.applyStepResult(runId, state, step, result, elapsed, startedAt);
        if (result.verdict !== "PASS") anyFail = true;
      }
      if (aborted) break;
    }

    // Codex round-2 C-2 + round-3 C-1: terminal save under per-runId mutex,
    // re-reading phase from disk inside the critical section so a
    // /run-cancel that landed after the last applyStepResult is honored
    // and not overwritten back to "done"/"failed".
    {
      const dagSnap: RunState = state;
      state = await withRunStateLock<RunState>(this.config.runsDir, runId, async () => {
        let terminal: RunState = dagSnap;
        if (!aborted) {
          const finalFresh = await loadRunState(this.config.runsDir, runId);
          if (finalFresh?.phase === "cancelling" || finalFresh?.phase === "cancelled") {
            terminal = { ...dagSnap, status: "aborted", phase: "cancelled" };
          } else {
            terminal = {
              ...dagSnap,
              status: anyFail ? "failed" : "succeeded",
              phase: anyFail ? "failed" : "done",
            };
          }
        }
        await saveRunState(this.config.runsDir, terminal);
        return terminal;
      });
    }
    this.clearUiStatus(runId);
    this.config.observer.emit({
      runId,
      category: "lifecycle",
      type: "run.end",
      payload: { status: state.status, iteration: state.iteration },
      summary: `Run ${runId} ended: ${state.status}`,
    });
    return state;
  }

  private async runDagStep(
    runId: string,
    state: RunState,
    workflow: Workflow,
    stepDef: Step,
  ): Promise<{ result: StepResult; elapsed: number; startedAt: string }> {
    this.config.observer.emit({
      runId,
      step: stepDef.name,
      iteration: state.iteration,
      category: "lifecycle",
      type: "step.start",
      payload: { step: stepDef.name },
    });
    this.uiCallbacks?.setStatus("engineering", `▶ ${stepDef.name}`);
    // Phase 5.6 §9.2: refresh TillDone footer alongside DAG step labels.
    void this.refreshTillDoneFooter(state);
    this.config.team.setStepContext(stepDef.name, workflow.steps.map((s) => s.name));
    const startedAt = new Date().toISOString();
    // Codex round-8 MEDIUM: monotonic clock for elapsed; see line ~505.
    const stepStart = performance.now();
    let result: StepResult;
    try {
      const ctx: StepContext = {
        run: { ...state, currentStep: stepDef.name },
        team: this.config.team,
        observer: this.config.observer,
        engine: this,
      };
      const timeoutSeconds = stepDef.timeoutSeconds ?? defaultStepTimeoutSeconds(stepDef.name);
      result = await runWithStepTimeout(stepDef.name, timeoutSeconds, () => stepDef.run(ctx));
    } catch (err) {
      if (err instanceof StepTimeoutError) {
        result = {
          success: false,
          verdict: "FAIL",
          error: err.message,
          issues: [
            `Step '${err.stepName}' timed out after ${err.elapsedMs}ms (budget ${err.budgetMs}ms). The agent did not emit a verdict within the step's allotted wall-clock budget.`,
          ],
        };
      } else {
        result = {
          success: false,
          verdict: "FAIL",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      this.config.team.markStepComplete(stepDef.name);
    }
    const elapsed = Math.max(0, (performance.now() - stepStart) / 1000);
    return { result, elapsed, startedAt };
  }

  private async applyStepResult(
    runId: string,
    state: RunState,
    stepDef: Step,
    result: StepResult,
    elapsed: number,
    startedAt?: string,
  ): Promise<RunState> {
    let next = tickBudget(state, elapsed, {
      costUsd: (result as any).costUsd,
      tokens: (result as any).tokens,
    });
    if (result.artifacts) {
      next = { ...next, artifacts: { ...next.artifacts, ...result.artifacts } };
    }
    next = updateStep(next, stepDef.name, {
      ...(startedAt ? { startedAt } : {}),
      verdict: result.verdict,
      issues: result.issues,
      handoffHint: result.handoffHint,
      artifacts: result.artifacts ? Object.values(result.artifacts) : undefined,
      endedAt: new Date().toISOString(),
      error: result.error,
    });
    next = { ...next, currentStep: stepDef.name };
    // C2 + round-3 C-1: pick up any concurrent phase mutation
    // (e.g., /run-cancel) before saving, so we don't clobber a 'cancelling'
    // write with stale in-memory phase. The reload+save is wrapped in
    // withRunStateLock so /run-cancel cannot interleave between the load
    // and the save within this process.
    {
      const stepSnap: RunState = next;
      next = await withRunStateLock<RunState>(this.config.runsDir, runId, async () => {
        const phaseFresh = await loadRunState(this.config.runsDir, runId);
        const merged: RunState = phaseFresh?.phase ? { ...stepSnap, phase: phaseFresh.phase } : stepSnap;
        await saveRunState(this.config.runsDir, merged);
        return merged;
      });
    }
    this.config.observer.emit({
      runId,
      step: stepDef.name,
      iteration: next.iteration,
      category: "lifecycle",
      type: "step.end",
      payload: { verdict: result.verdict, issues: result.issues, error: result.error },
    });
    return next;
  }

  async resumeRun(runId: string): Promise<RunState> {
    const state = await loadRunState(this.config.runsDir, runId);
    if (!state) throw new Error(`Run ${runId} not found`);
    // C3: only resume runs that are in a resumable state
    const resumable = ["pending", "running", "paused", "waiting_user"] as const;
    if (!resumable.includes(state.status as any)) {
      throw new Error(`Run ${runId} is in status '${state.status}' and cannot be resumed`);
    }
    return this.executeRun(runId);
  }

  async executeUntilPause(runId: string): Promise<RunState> {
    const state = await loadRunState(this.config.runsDir, runId);
    if (!state) throw new Error(`Run ${runId} not found`);
    // C3: guard against re-executing terminal runs
    const terminalStatuses = ["succeeded", "failed", "aborted"] as const;
    if (terminalStatuses.includes(state.status as any)) {
      return state;
    }
    if (state.status === "waiting_user") {
      await saveRunState(this.config.runsDir, { ...state, status: "running" });
    }
    return this.executeRun(runId);
  }

  async abortRun(runId: string): Promise<void> {
    const state = await loadRunState(this.config.runsDir, runId);
    if (!state) return;
    const aborted = { ...state, status: "aborted" as const };
    await saveRunState(this.config.runsDir, aborted);
    this.config.observer.emit({
      runId,
      category: "lifecycle",
      type: "run.end",
      payload: { status: "aborted" },
      summary: `Run ${runId} aborted`,
    });
    // Phase 5.7 round-4 L1: route through the same terminal UI cleanup
    // as executeRun's normal completion. Without this, an abort path
    // leaves any pending TillDone refresh timer alive and the tilldone
    // status key set to a stale rendered string.
    this.clearUiStatus(runId);
  }
}
