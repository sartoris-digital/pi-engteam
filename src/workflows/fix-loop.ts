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

const analyzeStep: Step = {
  name: "analyze",
  required: true,
  planMode: false, // needs Write to produce fix-plan.md
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `GOAL: ${ctx.run.goal}

Analyze the codebase to identify the root cause of the issue. Produce a concrete fix plan and write it to fix-plan.md.
Call VerdictEmit with verdict="PASS" and step="analyze" when analysis is complete and fix-plan.md is written — regardless of how many issues were found.
Only call VerdictEmit with verdict="FAIL" if you were unable to complete the analysis (e.g. cannot read the codebase).`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "root-cause-debugger", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        // C4: use a stable "fix-plan" key so implementStep can always find it
        artifacts: { "fix-plan": verdict.artifacts?.[0] ?? "fix-plan.md" },
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
  planMode: false,
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
  planMode: false,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const changedFiles = Object.entries(ctx.run.artifacts)
      .filter(([k]) => k.startsWith("impl-artifact-"))
      .map(([, v]) => v)
      .join("\n");

    const prompt = `GOAL: ${ctx.run.goal}
CHANGED FILES:
${changedFiles || "(see recent implement step artifacts)"}

Steps:
1. Locate the package.json that owns the changed files: walk up the directory tree from the first changed file until you find a package.json with a "test" script.
2. Run the test suite from THAT directory (not the cwd), using the command found in the test script (pnpm test, npm test, yarn test, etc.).
3. If no test suite covers these files (no package.json found, or project has no test script), call VerdictEmit with verdict="PASS" and note the gap in issues[].
4. If tests fail due to an infrastructure/environment problem (missing deps, not a Node.js project, wrong runtime), call VerdictEmit with verdict="PASS" and document the infra problem in handoffHint — do not loop on environment errors outside your control.
5. If tests fail because of a code bug in the changed files, call VerdictEmit with verdict="FAIL" with the specific failure in handoffHint.

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
  planMode: true,
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
  planMode: true,
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
    // M3: judge feedback is usually implementation feedback, not a reason to redo root-cause analysis
    { from: "judge-gate", when: (r) => r.verdict !== "PASS",  to: "implement" },
  ],
  defaults: {
    maxIterations: 12,
    maxCostUsd: 30,
    maxWallSeconds: 7200,
  },
};
