import { join } from "node:path";
import type { EffectiveRepoConfig } from "../config/schema.js";
import { hostGitOk } from "../git/host-git.js";
import type { SteerDecision } from "../steer/dialog.js";
import { checkBudget, computeIterationBudget, isTerminalStep, resetRoundIterationGrant } from "./budget.js";
import { writeEvidence } from "./evidence.js";
import { loadRunState, newRunState, readRunSecret, runDirPath, saveRunState, writeGeneratedJson } from "./state.js";
import {
  isEscalationCode,
  type Escalation,
  type EscalationCode,
  type EvidenceRecord,
  type FactoryEvent,
  type RunState,
  type Step,
  type StepContext,
  type StepRecord,
  type StepResult,
  type WhenScope,
  type Workflow,
} from "./types.js";

export type WhenEvaluator = (expr: string, scope: WhenScope) => boolean;
export type VerifierHook = (step: Step, ctx: StepContext, result: StepResult) => Promise<StepResult>;
export type CheckpointHook = (ctx: StepContext, message: string) => Promise<string | null>;

export interface EngineDeps {
  runsDir: string;
  evalWhen: WhenEvaluator;
  now?: () => number;
  emit?: (event: FactoryEvent) => void;
  verify?: VerifierHook;
  checkpoint?: CheckpointHook;
}

export interface StartRunParams {
  workflow: Workflow;
  cfg: EffectiveRepoConfig;
  lane: string;
  kind: RunState["kind"];
  tier: RunState["tier"];
  ticket: RunState["ticket"];
  workspaceDir: string;
  mainCheckout: string;
  branch: string;
  baseSha: string;
  cfgSha: string;
  budget: { fixRounds: number; maxWallSeconds: number; maxCostUsd: number };
}

/** SteerDecision is declared once in src/steer/dialog.ts; the engine only carries it. */
export interface ResumeOptions {
  decision?: SteerDecision;
  fromStep?: string;
  resetRounds?: string[];
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export const HUMAN_ACTIONS: Record<EscalationCode, string> = {
  "needs-decision": "Answer the open questions (write them under human-input/) then /factory resume <ref>",
  "env-setup-failed": "Fix the repo setupCommand or environment, then /factory resume <ref> --from <step>",
  "checks-timeout": "Raise checksTimeoutSeconds or fix the slow check, then /factory resume <ref> --from test",
  "gate-invalid": "Inspect the RED baseline under checks/, fix the gate tests, then /factory resume <ref> --from gate",
  "gate-baseline-green": "The gate tests pass on base; make them fail first, then /factory resume <ref> --from gate",
  "test-tampering": "Review the test-manifest diff in evidence/, revert unjustified test edits, then /factory resume <ref> --from implement",
  "scope-violation": "Review writes outside the allowed roots; widen writeRoots or /factory drop <ref>",
  "too-large": "Split the ticket or raise maxDiffLines/maxChangedFiles, then /factory resume <ref> --from implement",
  "loop-exhausted": "Fix the code in the worktree by hand, then /factory resume <ref> --from test, or /factory drop <ref>",
  stall: "The worker repeats the same issues; steer with notes or fix by hand, then /factory resume <ref> --from implement",
  "budget-exhausted": "Raise the lane budget or finish by hand from the worktree; host commits are kept locally",
  "safety-block": "Read the safety events in events.jsonl; if legitimate, grant a token and /factory resume <ref>",
  "config-tampered": "Restore .git config/hooks/remote and the .pi config, then /factory resume <ref>",
  "judge-fail-final": "Read verdict.md; fix by hand and /factory resume <ref> --from test, or /factory drop <ref>",
  "publish-refused": "Read escalation.json for the preflight reasons, fix the branch, then /factory resume <ref> --from publish",
  "push-rejected": "Fetch and rebase the lane branch on origin/<base>, then /factory resume <ref> --from publish",
  "approval-needed": "Review approvals/pending/ and /factory grant <runId>",
  "worker-crash": "Check the worker transcript and stderr tail in events.jsonl, then /factory resume <ref>",
  "workspace-lost": "Recreate the worktree with /factory retry <ref>; the branch is kept when host commits exist",
  "steer-timeout": "Approve or drop the run: /factory approve <ref> or /factory drop <ref>",
};

export function agentLabel(step: Step): string {
  if (step.kind === "agent") return step.agent ?? "agent";
  if (step.kind === "host") return `host:${step.host ?? "unknown"}`;
  return "human";
}

function escalationCodeOf(step: Step): EscalationCode {
  if (step.onFail.startsWith("escalate:")) {
    const code = step.onFail.slice("escalate:".length);
    if (isEscalationCode(code)) return code;
  }
  return "needs-decision";
}

interface Registered {
  workflow: Workflow;
  cfg: EffectiveRepoConfig;
}

interface Active {
  state: RunState;
  cancel: AbortController;
}

type TransitionOutcome = "halt" | "next" | "escalated";

interface StepRun {
  result: StepResult;
  skipped: boolean;
  ctx: StepContext;
}

export class Engine {
  private readonly registry = new Map<string, Registered>();
  private readonly active = new Map<string, Active>();
  private readonly now: () => number;
  private readonly emit: (event: FactoryEvent) => void;
  private readonly verify: VerifierHook;
  private readonly checkpoint: CheckpointHook;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.emit = deps.emit ?? (() => undefined);
    this.verify = deps.verify ?? (async () => ({ verdict: "PASS" }));
    this.checkpoint = deps.checkpoint ?? (async () => null);
  }

  /** Attach (or re-attach after a restart) the in-memory workflow a run executes. */
  registerWorkflow(runId: string, workflow: Workflow, cfg: EffectiveRepoConfig): void {
    this.registry.set(runId, { workflow, cfg });
  }

  async startRun(params: StartRunParams): Promise<RunState> {
    const first = params.workflow.steps.find((s) => !isTerminalStep(s));
    if (!first) throw new EngineError(`workflow ${params.workflow.name} has no runnable steps`);
    const maxIterations = computeIterationBudget({
      ...params.workflow,
      budget: { ...params.workflow.budget, fixRounds: params.budget.fixRounds },
    });
    const state = await newRunState(this.deps.runsDir, {
      workflow: params.workflow.name,
      lane: params.lane,
      kind: params.kind,
      tier: params.tier,
      currentStep: first.name,
      ticket: params.ticket,
      workspaceDir: params.workspaceDir,
      mainCheckout: params.mainCheckout,
      branch: params.branch,
      baseSha: params.baseSha,
      configSha: params.cfgSha,
      budget: { ...params.budget, maxIterations },
      now: this.now,
    });
    this.registerWorkflow(state.runId, params.workflow, params.cfg);
    return state;
  }

  async getRun(runId: string): Promise<RunState> {
    const state = await loadRunState(this.deps.runsDir, runId);
    if (!state) throw new EngineError(`run ${runId} not found under ${this.deps.runsDir}`);
    return state;
  }

  async executeRun(runId: string): Promise<RunState> {
    const reg = this.registry.get(runId);
    if (!reg) throw new EngineError(`no workflow registered for run ${runId}; call registerWorkflow first`);
    if (this.active.has(runId)) throw new EngineError(`run ${runId} is already executing`);
    const state = await this.getRun(runId);
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") return state;

    const cancel = new AbortController();
    this.active.set(runId, { state, cancel });
    const byName = new Map(reg.workflow.steps.map((s) => [s.name, s] as const));
    let segmentStart = this.now();
    const tick = (): void => {
      const t = this.now();
      state.wallSecondsUsed += (t - segmentStart) / 1000;
      segmentStart = t;
    };

    try {
      state.status = "running";
      delete state.pauseForUser;
      await this.save(state);
      this.emitRun(state, "run.start");

      for (;;) {
        if (state.phase === "cancelling") return await this.finish(state, "cancelled");
        const step = byName.get(state.currentStep);
        if (!step) {
          if (await this.escalate(reg, state, "needs-decision", `unknown step '${state.currentStep}'`)) return state;
          continue;
        }

        tick();
        if (!isTerminalStep(step)) {
          const check = checkBudget(state, reg.workflow);
          if (check.exhausted.includes("wall") || check.exhausted.includes("cost")) {
            const detail =
              `exhausted ${check.exhausted.join(",")}: wall ${state.wallSecondsUsed.toFixed(1)}s/${state.budget.maxWallSeconds}s, ` +
              `cost $${state.costUsd.toFixed(2)}/$${state.budget.maxCostUsd}`;
            if (await this.escalate(reg, state, "budget-exhausted", detail)) return state;
            continue;
          }
          if (check.exhausted.includes("iterations")) {
            const detail = `iteration backstop: ${state.iteration} >= maxIterations ${state.budget.maxIterations}`;
            if (await this.escalate(reg, state, "loop-exhausted", detail)) return state;
            continue;
          }
        }

        const round = state.steps.filter((r) => r.name === step.name).length;
        const startedAt = this.iso();
        this.emitStep(state, step, "stage.start", { round });
        const { result, skipped, ctx } = await this.runStep(reg, state, step, cancel.signal);
        tick();
        await this.finishStep(state, step, ctx, result, skipped, round, startedAt);

        if (state.phase === "cancelling") return await this.finish(state, "cancelled");
        // Last ordinary step can cross wall/cost; re-check before pause/halt/transition.
        // The terminal escalate step stays budget-exempt.
        if (!isTerminalStep(step)) {
          const post = checkBudget(state, reg.workflow);
          if (post.exhausted.includes("wall") || post.exhausted.includes("cost")) {
            const kinds = post.exhausted.filter((k) => k === "wall" || k === "cost");
            const detail =
              `exhausted ${kinds.join(",")}: wall ${state.wallSecondsUsed.toFixed(1)}s/${state.budget.maxWallSeconds}s, ` +
              `cost $${state.costUsd.toFixed(2)}/$${state.budget.maxCostUsd}`;
            if (await this.escalate(reg, state, "budget-exhausted", detail)) return state;
            continue;
          }
        }
        if (result.pauseForUser) {
          state.pauseForUser = result.pauseForUser;
          state.status = "waiting_user";
          await this.save(state);
          this.emitRun(state, "run.pause", { reason: result.pauseForUser.reason, step: step.name });
          return state;
        }
        if (isTerminalStep(step)) return await this.finish(state, "failed");
        if (result.escalate) {
          const detail = `step '${step.name}' requested escalation: ${(result.issues ?? []).join("; ") || "no issues reported"}`;
          if (await this.escalate(reg, state, result.escalate, detail)) return state;
          continue;
        }

        const outcome = await this.applyTransition(reg, state, step, result);
        if (outcome === "halt") return await this.finish(state, "succeeded");
        // finish()/escalate() mutate status via methods; CFA still sees "running".
        if (outcome === "escalated" && (state.status as RunState["status"]) === "failed") return state;
        await this.save(state);
      }
    } finally {
      this.active.delete(runId);
    }
  }

  async resumeRun(runId: string, opts: ResumeOptions = {}): Promise<RunState> {
    const reg = this.registry.get(runId);
    if (!reg) throw new EngineError(`no workflow registered for run ${runId}; call registerWorkflow first`);
    if (this.active.has(runId)) throw new EngineError(`run ${runId} is already executing`);
    const state = await this.getRun(runId);
    if (state.status === "running" || state.status === "succeeded" || state.status === "cancelled") {
      throw new EngineError(`run ${runId} cannot resume from status ${state.status}`);
    }
    if (state.status === "failed" && opts.fromStep === undefined) {
      throw new EngineError(`run ${runId} failed (${state.escalation?.code ?? "no code"}); pass fromStep to resume`);
    }
    if (opts.fromStep !== undefined) {
      if (!reg.workflow.steps.some((s) => s.name === opts.fromStep)) {
        throw new EngineError(`run ${runId} cannot resume from unknown step '${opts.fromStep}'`);
      }
      state.currentStep = opts.fromStep;
      delete state.escalation;
    }
    const grant = resetRoundIterationGrant(reg.workflow);
    for (const stage of opts.resetRounds ?? []) {
      const prev = state.rounds[stage] ?? 0;
      const next = Math.max(0, prev - 1);
      state.rounds[stage] = next;
      if (next < prev) state.budget.maxIterations += grant;
    }
    // Handed to the resumed step as ctx.state.resumeDecision and cleared once it runs.
    // The engine persists no decision file — src/steer/stage.ts owns that.
    if (opts.decision) state.resumeDecision = opts.decision;
    else delete state.resumeDecision;
    delete state.pauseForUser;
    state.status = "paused";
    await this.save(state);
    this.emitRun(state, "run.resume", { step: state.currentStep, decision: opts.decision?.action });
    return this.executeRun(runId);
  }

  async cancelRun(runId: string): Promise<RunState> {
    const live = this.active.get(runId);
    if (live) {
      live.state.phase = "cancelling";
      live.cancel.abort();
      return live.state; // executeRun finalises `cancelled` at the next boundary
    }
    const state = await this.getRun(runId);
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") return state;
    return this.finish(state, "cancelled");
  }

  // ---- private ------------------------------------------------------------

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private async save(state: RunState): Promise<void> {
    await saveRunState(this.deps.runsDir, state);
  }

  private emitRun(state: RunState, type: string, data?: Record<string, unknown>): void {
    this.emit({ category: "lifecycle", type, runId: state.runId, ts: this.iso(), step: state.currentStep, data });
  }

  private emitStep(state: RunState, step: Step, type: string, data?: Record<string, unknown>): void {
    this.emit({
      category: "stage",
      type,
      runId: state.runId,
      ts: this.iso(),
      step: step.name,
      agent: agentLabel(step),
      data,
    });
  }

  private async finish(state: RunState, status: "succeeded" | "failed" | "cancelled"): Promise<RunState> {
    state.status = status;
    delete state.phase;
    await this.save(state);
    this.emitRun(state, "run.end", { status });
    return state;
  }

  private whenScope(state: RunState, lane: string): WhenScope {
    return {
      tier: state.tier,
      kind: state.kind,
      lane,
      iteration: state.iteration,
      rounds: { ...state.rounds },
      artifacts: { ...state.artifacts },
    };
  }

  private async runStep(reg: Registered, state: RunState, step: Step, cancelSignal: AbortSignal): Promise<StepRun> {
    const controller = new AbortController();
    const onCancel = (): void => controller.abort();
    if (cancelSignal.aborted) controller.abort();
    else cancelSignal.addEventListener("abort", onCancel, { once: true });
    const ctx: StepContext = {
      state,
      runDir: runDirPath(this.deps.runsDir, state.runId),
      workspaceDir: state.workspaceDir,
      cfg: reg.cfg,
      nonce: state.nonce,
      emit: this.emit,
      signal: controller.signal,
    };
    try {
      if (step.when !== undefined) {
        let applies: boolean;
        try {
          applies = this.deps.evalWhen(step.when, this.whenScope(state, reg.workflow.lane));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            result: { verdict: "FAIL", issues: [`when '${step.when}' failed to evaluate: ${message}`], escalate: "needs-decision" },
            skipped: false,
            ctx,
          };
        }
        if (!applies) return { result: { verdict: "PASS", evidence: { skipped: true } }, skipped: true, ctx };
      }
      // Consume the one-attempt decision on disk before invoke; the in-flight step
      // sees a detached snapshot. A crash after the step must not replay it.
      const resumeDecision = state.resumeDecision;
      if (resumeDecision !== undefined) {
        delete state.resumeDecision;
        await this.save(state);
      }
      const stepCtx: StepContext =
        resumeDecision === undefined ? ctx : { ...ctx, state: { ...state, resumeDecision: structuredClone(resumeDecision) } };
      let result = await this.invoke(step, stepCtx, controller);
      if (result.verdict === "PASS" && step.verify) {
        // Checkpoint first so verify_git_clean sees the post-commit tree (generated docs remain).
        if (result.commit) {
          const sha = await this.checkpoint(stepCtx, result.commit.message);
          if (sha) state.hostCommits.push(sha);
          delete result.commit;
        }
        const verified = await this.verify(step, stepCtx, result);
        if (verified.verdict !== "PASS") {
          result = {
            ...result,
            verdict: verified.verdict,
            issues: [...(result.issues ?? []), ...(verified.issues ?? [])],
            ...(verified.escalate !== undefined ? { escalate: verified.escalate } : {}),
          };
        }
      }
      return { result, skipped: false, ctx: stepCtx };
    } finally {
      cancelSignal.removeEventListener("abort", onCancel);
    }
  }

  /** Runs the step body under its timeout; never returns PASS after the deadline, never throws. */
  private async invoke(step: Step, ctx: StepContext, controller: AbortController): Promise<StepResult> {
    const timeoutMs = step.timeoutSeconds !== undefined && step.timeoutSeconds > 0 ? step.timeoutSeconds * 1000 : undefined;
    const timeoutResult: StepResult = {
      verdict: "FAIL",
      issues: [`step '${step.name}' timed out after ${step.timeoutSeconds ?? 0}s`],
      evidence: { timedOut: true },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<StepResult>((resolve) => {
      if (timeoutMs === undefined) return; // no deadline: this promise never settles
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(timeoutResult);
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([step.run(ctx), deadline]);
      if (timedOut) return { ...timeoutResult, evidence: { ...(result.evidence ?? {}), timedOut: true } };
      return result;
    } catch (err) {
      if (timedOut) return timeoutResult;
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) return { verdict: "FAIL", issues: [`step '${step.name}' aborted: ${message}`] };
      return { verdict: "FAIL", issues: [`step '${step.name}' threw: ${message}`], escalate: "worker-crash" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async finishStep(
    state: RunState,
    step: Step,
    ctx: StepContext,
    result: StepResult,
    skipped: boolean,
    round: number,
    startedAt: string,
  ): Promise<void> {
    const ev = result.evidence ?? {};
    let headSha = ev.headSha ?? state.hostCommits[state.hostCommits.length - 1] ?? state.baseSha;
    if (step.safetyGating && result.verdict === "PASS" && !skipped) {
      try {
        headSha = await hostGitOk(["rev-parse", "HEAD"], { cwd: ctx.workspaceDir });
      } catch {
        // workspace HEAD unreadable: keep evidence/hostCommits/base fallback
      }
      state.judgedSha = headSha;
    }
    const record: EvidenceRecord = {
      stage: step.name,
      round,
      agent: agentLabel(step),
      verdict: ev.verdict ?? result.verdict,
      predicates: ev.predicates ?? [],
      artifacts: ev.artifacts ?? [],
      commands: ev.commands ?? [],
      synthesized: ev.synthesized ?? [],
      timedOut: ev.timedOut ?? false,
      headSha,
      at: this.iso(),
    };
    if (skipped || ev.skipped) record.skipped = true;
    if (ev.humanIntervened) record.humanIntervened = ev.humanIntervened;
    const secret = await readRunSecret(ctx.runDir);
    const evidencePath = await writeEvidence(ctx.runDir, record, secret);

    const rec: StepRecord = { name: step.name, round, verdict: result.verdict, startedAt, endedAt: this.iso(), evidencePath };
    if (result.issues && result.issues.length > 0) rec.issues = result.issues;
    state.steps.push(rec);
    if (result.artifacts) Object.assign(state.artifacts, result.artifacts);
    if (typeof result.costUsd === "number" && result.costUsd > 0) state.costUsd += result.costUsd;
    if (result.commit && !skipped) {
      const sha = await this.checkpoint(ctx, result.commit.message);
      if (sha) state.hostCommits.push(sha);
    }
    await this.save(state);
    this.emitStep(state, step, "stage.end", { round, verdict: result.verdict, skipped, timedOut: record.timedOut });
  }

  /**
   * Record the escalation and route to the terminal escalate step.
   * Returns true when the run is already finished (no terminal step in the workflow).
   */
  private async escalate(reg: Registered, state: RunState, code: EscalationCode, detail: string): Promise<boolean> {
    const escalation: Escalation = { code, detail, at: this.iso(), step: state.currentStep, humanAction: HUMAN_ACTIONS[code] };
    state.escalation = escalation;
    const runDir = runDirPath(this.deps.runsDir, state.runId);
    await writeGeneratedJson(join(runDir, "escalation.json"), state.runId, escalation);
    this.emitRun(state, "run.escalate", { code, detail });
    const terminal = reg.workflow.steps.find(isTerminalStep);
    if (terminal) {
      state.currentStep = terminal.name;
      await this.save(state);
      return false;
    }
    await this.finish(state, "failed");
    return true;
  }

  private async applyTransition(reg: Registered, state: RunState, step: Step, result: StepResult): Promise<TransitionOutcome> {
    const transition = reg.workflow.transitions.find((t) => t.from === step.name && t.when(result));
    if (!transition) {
      await this.escalate(reg, state, "needs-decision", `no transition from '${step.name}' for verdict ${result.verdict}`);
      return "escalated";
    }
    if (transition.to === "halt") return "halt";
    if (transition.to === "escalate") {
      const detail = `step '${step.name}' ${result.verdict}: ${(result.issues ?? []).join("; ") || "no issues reported"}`;
      await this.escalate(reg, state, escalationCodeOf(step), detail);
      return "escalated";
    }
    const target = transition.to;
    if (!reg.workflow.steps.some((s) => s.name === target)) {
      await this.escalate(reg, state, "needs-decision", `transition from '${step.name}' targets unknown step '${target}'`);
      return "escalated";
    }

    if (result.verdict !== "PASS" && step.onFail === "fix-round") {
      // The implement-class target's fix-round counter: consumed by every back-edge into it.
      const used = (state.rounds[target] ?? 0) + 1;
      state.rounds[target] = used;
      if (used > state.budget.fixRounds) {
        const detail =
          `fix rounds for '${target}' exhausted: ${used} > fixRounds ${state.budget.fixRounds} ` +
          `(after '${step.name}' ${result.verdict}: ${(result.issues ?? []).join("; ") || "no issues reported"})`;
        await this.escalate(reg, state, "loop-exhausted", detail);
        return "escalated";
      }
      // A stage's own bound on how many fix rounds it may request (e.g. review 1, security 1).
      if (step.maxRounds !== undefined) {
        const own = (state.rounds[step.name] ?? 0) + 1;
        state.rounds[step.name] = own;
        if (own > step.maxRounds) {
          await this.escalate(reg, state, "loop-exhausted", `'${step.name}' exceeded maxRounds ${step.maxRounds} (${own} fix rounds requested)`);
          return "escalated";
        }
      }
    }

    state.iteration += 1;
    state.currentStep = target;
    return "next";
  }
}
