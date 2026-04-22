import type { RunState, BudgetStatus } from "../types.js";
import type { Workflow, StepContext, StepResult } from "../workflows/types.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { Observer } from "../observer/Observer.js";
import {
  createRunState,
  saveRunState,
  loadRunState,
  updateStep,
} from "./RunState.js";
import { checkBudget, tickBudget } from "./BudgetGuard.js";
import { writeActiveRun } from "./ActiveRun.js";

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

  constructor(private config: ADWConfig) {}

  /** Attach Pi UI callbacks so the engine can surface step progress in the TUI. */
  setUiCallbacks(cbs: UiCallbacks): void {
    this.uiCallbacks = cbs;
  }

  /** Detach UI callbacks (called at run end or when context is no longer valid). */
  clearUiCallbacks(): void {
    this.uiCallbacks = undefined;
  }

  private clearUiStatus(): void {
    this.uiCallbacks?.setStatus("engteam", undefined);
    this.uiCallbacks?.setStatus("engteam_out", undefined);
    this.config.team.setAgentLineCallback?.(undefined);
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
    state = { ...state, currentStep: workflow.steps[0].name };
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

    while (state.status === "running") {
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
      this.uiCallbacks?.setStatus("engteam", `▶ ${currentStep} (${stepIndex + 1}/${totalSteps})`);
      this.config.team.setAgentLineCallback?.((agent, line) => {
        this.uiCallbacks?.setStatus("engteam_out", `${agent}: ${line.slice(0, 120)}`);
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
      this.uiCallbacks?.setStatus("engteam", `${tick} ${state.currentStep} · ${result.verdict}`);
      this.uiCallbacks?.setStatus("engteam_out", undefined);
      this.config.team.setAgentLineCallback?.(undefined);
      if (result.verdict !== "PASS") {
        const detail = result.issues?.slice(0, 2).join("; ") ?? result.error ?? "";
        this.uiCallbacks?.notify(
          `✗ ${state.currentStep}: FAIL${detail ? ` — ${detail.slice(0, 140)}` : ""}`,
          "warning",
        );
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

      await saveRunState(this.config.runsDir, state);

      // Pause if the completed step requested it
      if (stepDef.pauseAfter && result.verdict === "PASS") {
        state = { ...state, status: "waiting_user" };
        await writeActiveRun({
          runId,
          phase: stepDef.pauseAfter,
          stepName: stepDef.name,
          runsDir: this.config.runsDir,
        });
        await saveRunState(this.config.runsDir, state);

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
        this.uiCallbacks?.setStatus("engteam", `⏸ waiting for user (${stepDef.pauseAfter})`);
        break;
      }
    }

    await saveRunState(this.config.runsDir, state);

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
