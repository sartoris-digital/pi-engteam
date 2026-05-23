import { join } from "path";
import { writeFileSync, existsSync } from "fs";
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";
import { resolveArtifactPath } from "./helpers.js";

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
  }, { runId: ctx.run.runId });
  if (!verdict) {
    throw new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within timeout`);
  }
  return verdict;
}

const planStep: Step = {
  name: "plan",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are being asked to plan the following goal:

GOAL: ${ctx.run.goal}

Please:
1. Analyze the goal and break it into concrete, actionable sub-tasks
2. Identify which files need to be created or modified
3. Note any risks or unknowns
4. Write the plan as a numbered list with clear implementation steps

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "plan"
- verdict: "PASS" with artifacts: ["plan.md"] (plan written and feasible)
- verdict: "FAIL" with issues listed (goal not feasible or more information needed)

Writing your plan in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "planner", prompt, "plan");
      const planArtifact = resolveArtifactPath(ctx, verdict.artifacts?.[0], "plan.md");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { plan: planArtifact },
      };
    } catch (err) {
      // Timeout fallback: write stub plan so build step can proceed
      const planPath = resolveArtifactPath(ctx, undefined, "plan.md");
      try {
        const { writeFileSync } = await import("fs");
        writeFileSync(planPath, `# Plan\n\nGoal: ${ctx.run.goal}\n\nPlan generation timed out — proceeding with implementation based on goal.\n\n1. Analyze the goal and codebase\n2. Implement the required changes\n3. Write tests in tests/unit/\n4. Verify implementation\n`);
      } catch { /* best-effort */ }
      return {
        success: true,
        verdict: "PASS",
        issues: [`Plan timed out — using stub: ${err instanceof Error ? err.message : String(err)}`],
        artifacts: { plan: planPath },
      };
    }
  },
};

const buildStep: Step = {
  name: "build",
  required: true,
  timeoutSeconds: 1800,
  verify: true,
  agent: "implementer",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["plan"] ?? "No plan artifact found";
    const prompt = `You are the implementer. Here is the plan you need to execute:

PLAN LOCATION: ${planArtifact}

Please:
1. Read the plan file
2. Implement each step in order
3. Write tests alongside implementation (TDD)
4. For any destructive operation (git push, npm install, file delete), call RequestApproval first

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "build"
- verdict: "PASS" (implementation complete, tests passing)
- verdict: "FAIL" with specific issues listed (if blocked or tests failing)

Writing your summary in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "build");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
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

const reviewStep: Step = {
  name: "review",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const runDir = join(ctx.engine.getRunsDir(), ctx.run.runId);
    const reviewPath = join(runDir, "review.md");
    const prompt = `You are the reviewer. Please review the implementation for the following goal:

GOAL: ${ctx.run.goal}

Previous steps completed: ${ctx.run.steps.map(s => s.name).join(", ")}

Please:
1. Read all changed/created files
2. Check for logical errors, edge cases, missing tests
3. Verify the implementation matches the plan
4. Look for security issues, performance problems, or maintainability concerns

Write your detailed review findings to this EXACT absolute path: ${reviewPath}

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "review"
- verdict: "PASS" (implementation is correct, complete, and maintainable)
- verdict: "FAIL" with a specific list of issues (what exactly is wrong and where)
- handoffHint: "security" | "perf" | "re-plan" if the issue category warrants specialist escalation
- artifacts: ["${reviewPath}"]

Writing your review in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "reviewer", prompt, "review");
      if (!existsSync(reviewPath)) {
        try {
          const lines = [`# Code Review: ${verdict.verdict}`];
          if (verdict.issues?.length) lines.push(`\n## Issues\n${verdict.issues.map(i => `- ${i}`).join("\n")}`);
          if (verdict.handoffHint) lines.push(`\n## Escalation: ${verdict.handoffHint}`);
          writeFileSync(reviewPath, lines.join("\n") + "\n");
        } catch { /* best-effort */ }
      }
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: { "review": reviewPath },
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

const fixStep: Step = {
  name: "fix",
  required: true,
  timeoutSeconds: 1800,
  verify: true,
  agent: "implementer",
  run: async (ctx: StepContext): Promise<StepResult> => {
    // Codex round-10 HIGH: fence worker-supplied review issues so the
    // reviewer cannot inject instructions into the implementer's prompt.
    const { fenceArray } = await import("../safety/prompt-fence.js");
    const reviewIssuesRaw = [...ctx.run.steps].reverse().find(s => s.name === "review")?.issues;
    const reviewIssues = reviewIssuesRaw && reviewIssuesRaw.length > 0
      ? fenceArray(reviewIssuesRaw, "REVIEW_ISSUES")
      : "No specific issues provided";
    const prompt = `GOAL: ${ctx.run.goal}
REVIEW ISSUES:
${reviewIssues}

Fix all issues listed above. Run tests after each fix.

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "fix"
- verdict: "PASS" (all issues fixed, tests passing)
- verdict: "FAIL" with specific issues listed (if blocked)

Writing your summary in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "fix");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
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

export const planBuildReviewFix: Workflow = {
  name: "plan-build-review-fix",
  description: "Plan a feature, implement it, review for correctness, then fix issues in a bounded loop.",
  steps: [planStep, buildStep, reviewStep, fixStep],
  transitions: [
    { from: "plan",   when: (r) => r.verdict === "PASS",  to: "build" },
    { from: "plan",   when: (r) => r.verdict !== "PASS",  to: "halt" },
    { from: "build",  when: (r) => r.verdict === "PASS",  to: "review" },
    // M4: build failures loop back to plan so the planner can revise rather than halting
    { from: "build",  when: (r) => r.verdict !== "PASS",  to: "plan" },
    { from: "review", when: (r) => r.verdict === "PASS",  to: "halt" },
    { from: "review", when: (r) => r.verdict !== "PASS",  to: "fix" },
    { from: "fix",    when: (r) => r.verdict === "PASS",  to: "review" },
    // H3: if the fixer is blocked, re-plan instead of halting the self-healing workflow
    { from: "fix",    when: (r) => r.verdict !== "PASS",  to: "plan" },
  ],
  defaults: {
    maxIterations: 12,
    maxCostUsd: 30,
    maxWallSeconds: 7200,
  },
};
