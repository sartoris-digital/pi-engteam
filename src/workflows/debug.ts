import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const softReminder = setTimeout(() => {
      ctx.team.deliver(agentName, {
        id: crypto.randomUUID(),
        from: "system",
        to: agentName,
        summary: `Reminder: step ${stepName} nearing timeout`,
        message: `You have 2 minutes remaining to emit a verdict for step "${stepName}". Call VerdictEmit now.`,
        ts: new Date().toISOString(),
      }).catch(() => {});
    }, 8 * 60 * 1000);

    const timeout = setTimeout(() => {
      clearTimeout(softReminder);
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(ctx.run.runId, stepName, (v: VerdictPayload) => {
      clearTimeout(softReminder);
      clearTimeout(timeout);
      resolve(v);
    });

    ctx.team.deliver(agentName, {
      id: crypto.randomUUID(),
      from: "system",
      to: agentName,
      summary: `Execute step: ${stepName}`,
      message: prompt,
      ts: new Date().toISOString(),
    }).catch(reject);
  });
}

const gatherContextStep: Step = {
  name: "gather-context",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const codePrompt = `GOAL: ${ctx.run.goal}

Retrieve relevant code context for debugging. Identify the files, functions, and modules involved in the reported issue. Summarize your findings and write them to debug-code-context.md.
Call VerdictEmit with step="gather-context-code".`;

    try {
      const codeCtx = await waitForAgentVerdict(ctx, "knowledge-retriever", codePrompt, "gather-context-code");
      if (codeCtx.verdict !== "PASS") {
        return {
          success: false,
          verdict: "FAIL",
          issues: codeCtx.issues,
          error: "knowledge-retriever failed to gather code context",
        };
      }

      const tracePrompt = `GOAL: ${ctx.run.goal}

Retrieve observability data relevant to the issue: logs, traces, metrics, error events. Summarize findings and write them to debug-traces.md.
Call VerdictEmit with step="gather-context-traces".`;

      const traceCtx = await waitForAgentVerdict(ctx, "observability-archivist", tracePrompt, "gather-context-traces");
      if (traceCtx.verdict !== "PASS") {
        return {
          success: false,
          verdict: "FAIL",
          issues: traceCtx.issues,
          error: "observability-archivist failed to gather trace context",
        };
      }

      return {
        success: true,
        verdict: "PASS",
        artifacts: {
          "code-context": codeCtx.artifacts?.[0] ?? "debug-code-context.md",
          "trace-context": traceCtx.artifacts?.[0] ?? "debug-traces.md",
        },
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const codeContext = ctx.run.artifacts["code-context"] ?? "debug-code-context.md";
    const traceContext = ctx.run.artifacts["trace-context"] ?? "debug-traces.md";

    const prompt = `GOAL: ${ctx.run.goal}
CODE CONTEXT: ${codeContext}
TRACE CONTEXT: ${traceContext}

Perform root cause analysis using the gathered context. Identify the precise failure point, contributing factors, and why the issue occurs. Write your findings to debug-report.md.
Call VerdictEmit with step="analyze".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "root-cause-debugger", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`root-cause-${i}`, a]))
          : { "root-cause": ctx.run.artifacts["root-cause"] ?? "debug-report.md" },
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const proposeFixStep: Step = {
  name: "propose-fix",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const analysisNotes = ctx.run.steps.findLast(s => s.name === "analyze")?.issues;

    const prompt = `ROOT CAUSE: ${ctx.run.artifacts["root-cause"] ?? "See debug-report.md"}

Propose 2-3 concrete fix options. For each: describe the change, trade-offs, and rollback plan.
${analysisNotes ? `\nANALYSIS NOTES:\n${analysisNotes.join("\n")}` : ""}
Call VerdictEmit with step="propose-fix".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "propose-fix");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`fix-option-${i}`, a]))
          : {},
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const priorFeedback = ctx.run.steps.findLast(s => s.name === "judge-gate")?.issues;

    const prompt = `ROOT CAUSE AND FIX OPTIONS: See debug-report.md and propose-fix artifacts.
Select the recommended fix option. If acceptable, PASS. If more investigation needed, FAIL.
${priorFeedback ? `\nPREVIOUS FEEDBACK:\n${priorFeedback.join("\n")}` : ""}
Call VerdictEmit with step="judge-gate".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export const debug: Workflow = {
  name: "debug",
  description: "Gather context, perform root cause analysis, propose fix options, and select the best fix.",
  steps: [gatherContextStep, analyzeStep, proposeFixStep, judgeGateStep],
  transitions: [
    { from: "gather-context", when: (r) => r.verdict === "PASS",  to: "analyze" },
    { from: "gather-context", when: (r) => r.verdict !== "PASS",  to: "halt" },
    { from: "analyze",        when: (r) => r.verdict === "PASS",  to: "propose-fix" },
    { from: "analyze",        when: (r) => r.verdict !== "PASS",  to: "halt" },
    { from: "propose-fix",    when: (r) => r.verdict === "PASS",  to: "judge-gate" },
    { from: "propose-fix",    when: (r) => r.verdict !== "PASS",  to: "analyze" },
    { from: "judge-gate",     when: (r) => r.verdict === "PASS",  to: "halt" },
    { from: "judge-gate",     when: (r) => r.verdict !== "PASS",  to: "analyze" },
  ],
  defaults: {
    maxIterations: 6,
    maxCostUsd: 20,
    maxWallSeconds: 3600,
  },
};
