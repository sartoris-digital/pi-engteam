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

const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `GOAL: ${ctx.run.goal}

Analyze the codebase to identify the root cause of the issue. Produce a concrete fix plan and write it to fix-plan.md.
Call VerdictEmit with step="analyze".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "root-cause-debugger", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`fix-plan-${i}`, a]))
          : { "fix-plan": "fix-plan.md" },
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

const implementStep: Step = {
  name: "implement",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const testHint = ctx.run.steps.findLast(s => s.name === "test")?.handoffHint;
    const reviewIssues = ctx.run.steps.findLast(s => s.name === "review")?.issues;
    const judgeIssues = ctx.run.steps.findLast(s => s.name === "judge-gate")?.issues;

    const prompt = `GOAL: ${ctx.run.goal}
FIX PLAN: ${ctx.run.artifacts["fix-plan"] ?? "See analyze step artifacts"}
${testHint ? `\nFAILING TESTS:\n${testHint}` : ""}
${reviewIssues ? `\nREVIEWER ISSUES:\n${reviewIssues.join("\n")}` : ""}
${judgeIssues ? `\nJUDGE ISSUES:\n${judgeIssues.join("\n")}` : ""}

Implement the fix. Call VerdictEmit with step="implement".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "implement");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`impl-artifact-${i}`, a]))
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

const testStep: Step = {
  name: "test",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `Run pnpm test. If all pass: PASS. If any fail: FAIL with the specific failure output in handoffHint.
Call VerdictEmit with step="test".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "test");
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

const reviewStep: Step = {
  name: "review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `GOAL: ${ctx.run.goal}

Review the implementation for correctness, edge cases, and code quality. Verify the fix addresses the root cause without introducing regressions.
Call VerdictEmit with step="review".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "reviewer", prompt, "review");
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

const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const priorFeedback = ctx.run.steps.findLast(s => s.name === "judge-gate")?.issues;

    const prompt = `GOAL: ${ctx.run.goal}

Review the implementation, test results, and code review findings. Confirm the fix is complete and correct.
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

export const fixLoop: Workflow = {
  name: "fix-loop",
  description: "Autonomously analyze, implement, test, review, and judge a fix in a self-healing loop.",
  steps: [analyzeStep, implementStep, testStep, reviewStep, judgeGateStep],
  transitions: [
    { from: "analyze",    when: (r) => r.verdict === "PASS",  to: "implement" },
    { from: "analyze",    when: (r) => r.verdict !== "PASS",  to: "halt" },
    { from: "implement",  when: (r) => r.verdict === "PASS",  to: "test" },
    { from: "implement",  when: (r) => r.verdict !== "PASS",  to: "analyze" },
    { from: "test",       when: (r) => r.verdict === "PASS",  to: "review" },
    { from: "test",       when: (r) => r.verdict !== "PASS",  to: "implement" },
    { from: "review",     when: (r) => r.verdict === "PASS",  to: "judge-gate" },
    { from: "review",     when: (r) => r.verdict !== "PASS",  to: "implement" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS",  to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS",  to: "analyze" },
  ],
  defaults: {
    maxIterations: 12,
    maxCostUsd: 30,
    maxWallSeconds: 7200,
  },
};
