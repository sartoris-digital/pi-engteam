import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  const verdict = await ctx.team.deliver(agentName, {
    id: crypto.randomUUID(),
    from: "system",
    to: agentName,
    summary: `Execute step: ${stepName}`,
    message: prompt,
    ts: new Date().toISOString(),
  });
  if (!verdict) {
    throw new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within timeout`);
  }
  return verdict;
}

const auditStep: Step = {
  name: "audit",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `GOAL: ${ctx.run.goal}

Audit the codebase for test coverage gaps. Identify untested functions, missing edge cases, and uncovered error paths.
- If gaps found: list them, call VerdictEmit with step="audit", verdict="PASS" (gaps to fill)
- If NO gaps found: call VerdictEmit with step="audit", verdict="PASS", handoffHint="no-gaps", summary="Coverage is adequate — no gaps found"`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "audit");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        // C4: stable "audit-gaps" key so writeTestsStep can always find it
        artifacts: { "audit-gaps": verdict.artifacts?.[0] ?? "audit-gaps.md" },
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

const writeTestsStep: Step = {
  name: "write-tests",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const reviewIssues = ctx.run.steps.findLast(s => s.name === "review")?.issues;
    const validateHint = ctx.run.steps.findLast(s => s.name === "validate")?.handoffHint;

    const prompt = `GOAL: ${ctx.run.goal}
COVERAGE GAPS: ${ctx.run.artifacts["audit-gaps"] ?? "See audit step output"}
${reviewIssues ? `\nREVIEWER ISSUES TO ADDRESS:\n${reviewIssues.join("\n")}` : ""}
${validateHint ? `\nFAILING TESTS:\n${validateHint}` : ""}

Write the missing tests. Call VerdictEmit with step="write-tests".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "write-tests");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`test-artifact-${i}`, a]))
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

const validateStep: Step = {
  name: "validate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `Run pnpm test. If all pass: PASS. If any fail: FAIL with the specific failure output in handoffHint.
Call VerdictEmit with step="validate".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "validate");
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
    const prompt = `Review the newly written tests for quality: do they actually test the right behavior, cover edge cases, use correct assertions?
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
Review all test artifacts. Confirm the test suite is adequate.
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

export const verify: Workflow = {
  name: "verify",
  description: "Audit test coverage, write missing tests, validate and review the test suite.",
  steps: [auditStep, writeTestsStep, validateStep, reviewStep, judgeGateStep],
  transitions: [
    { from: "audit",       when: (r) => r.verdict === "PASS" && r.handoffHint !== "no-gaps", to: "write-tests" },
    { from: "audit",       when: (r) => r.verdict === "PASS" && r.handoffHint === "no-gaps", to: "halt" },
    { from: "audit",       when: (r) => r.verdict !== "PASS",                                to: "halt" },
    { from: "write-tests", when: (r) => r.verdict === "PASS",  to: "validate" },
    // M3: retry write-tests instead of halting — budget exhaustion is the backstop
    { from: "write-tests", when: (r) => r.verdict !== "PASS",  to: "write-tests" },
    { from: "validate",    when: (r) => r.verdict === "PASS",                               to: "review" },
    { from: "validate",    when: (r) => r.verdict !== "PASS",                               to: "write-tests" },
    { from: "review",      when: (r) => r.verdict === "PASS",                               to: "judge-gate" },
    { from: "review",      when: (r) => r.verdict !== "PASS",                               to: "write-tests" },
    { from: "judge-gate",  when: (r) => r.verdict === "PASS",                               to: "halt" },
    { from: "judge-gate",  when: (r) => r.verdict !== "PASS",                               to: "write-tests" },
  ],
  defaults: {
    maxIterations: 8,
    maxCostUsd: 20,
    maxWallSeconds: 3600,
  },
};
