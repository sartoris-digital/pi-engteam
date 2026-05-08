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

type ADWConfig = {
  runsDir: string;
  workflows: Map<string, Workflow>;
  team: TeamRuntime;
  observer: Observer;
};

type StartRunParams = {
  workflow: string;
  goal: string;
  budget: Parameters<typeof createRunState>[0]["budget"];
  initialArtifacts?: string[];
};

type UiCallbacks = {
  notify: (msg: string, type?: "info" | "warning" | "error") => void;
  setStatus: (key: string, text: string | undefined) => void;
};

export class ADWEngine {
  private uiCallbacks?: UiCallbacks;

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

  /** Attach Pi UI callbacks so the engine can surface step progress in the TUI. */
  setUiCallbacks(cbs: UiCallbacks): void {
    this.uiCallbacks = cbs;
  }

  /** Detach UI callbacks (called at run end or when context is no longer valid). */
  clearUiCallbacks(): void {
    this.uiCallbacks = undefined;
  }

  // Phase 5.6 round-1 H1: monotonic sequence so a stale async footer
  // refresh (one that started earlier but completed later) doesn't
  // overwrite a newer setStatus or a clear. Each refresh captures the
  // current seq value at start; if the seq has advanced or
  // clearUiStatus has been called by the time loadTasks resolves, the
  // setStatus is skipped.
  private footerRefreshSeq = 0;

  private clearUiStatus(): void {
    this.uiCallbacks?.setStatus("engineering", undefined);
    this.uiCallbacks?.setStatus("engineering_out", undefined);
    this.uiCallbacks?.setStatus("tilldone", undefined);
    // Bump seq so any in-flight refreshes see a stale token and bail.
    this.footerRefreshSeq++;
    this.config.team.setAgentLineCallback?.(undefined);
  }

  /**
   * Phase 5.6 §9.2: refresh the Pi TUI footer widget showing TillDone
   * task progress alongside agent activity. Best-effort — a missing
   * tasks.json or callback is silently a no-op.
   */
  private async refreshTillDoneFooter(state: RunState): Promise<void> {
    if (!this.uiCallbacks) return;
    const myToken = ++this.footerRefreshSeq;
    try {
      const tasks = await loadTasks(this.config.runsDir, state.runId);
      // Round-1 H1: drop stale refresh writes. If a later refresh OR a
      // clear has bumped the seq while we were awaiting loadTasks, our
      // setStatus would be incorrect.
      if (myToken !== this.footerRefreshSeq) return;
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
    let state = await createRunState({
      runId,
      workflow: params.workflow,
      goal: params.goal,
      budget: params.budget,
    });
    state = { ...state, currentStep: workflow.steps[0].name, phase: "active" };
    await saveRunState(this.config.runsDir, state);

    const { writeFile } = await import("fs/promises");
    const { join, basename, extname } = await import("path");
    await writeFile(
      join(this.config.runsDir, "active-run.txt"),
      runId,
    );

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

    const workflow = this.config.workflows.get(state.workflow);
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

      const stepStart = Date.now();
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
        result = await stepDef.run(ctx);
      } catch (err) {
        result = {
          success: false,
          verdict: "FAIL",
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.config.team.markStepComplete(state.currentStep);
      }

      const elapsed = (Date.now() - stepStart) / 1000;
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

    this.clearUiStatus();

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
      // maxIterations gate actually fires; a level represents one unit of
      // forward progress (parallel siblings + sequential after them).
      state = { ...state, iteration: state.iteration + 1 };
      const parallelResults = await Promise.allSettled(
        level.parallel.map((s) => this.runDagStep(runId, state, workflow, s)),
      );
      for (let i = 0; i < parallelResults.length; i++) {
        const step = level.parallel[i];
        const r = parallelResults[i];
        const result: StepResult = r.status === "fulfilled"
          ? r.value.result
          : { success: false, verdict: "FAIL", error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
        const elapsed = r.status === "fulfilled" ? r.value.elapsed : 0;
        const startedAt = r.status === "fulfilled" ? r.value.startedAt : undefined;
        state = await this.applyStepResult(runId, state, step, result, elapsed, startedAt);
        if (result.verdict !== "PASS") anyFail = true;
      }

      for (const step of level.sequential) {
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
    this.clearUiStatus();
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
    const stepStart = Date.now();
    let result: StepResult;
    try {
      const ctx: StepContext = {
        run: { ...state, currentStep: stepDef.name },
        team: this.config.team,
        observer: this.config.observer,
        engine: this,
      };
      result = await stepDef.run(ctx);
    } catch (err) {
      result = {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.config.team.markStepComplete(stepDef.name);
    }
    const elapsed = (Date.now() - stepStart) / 1000;
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
  }
}
