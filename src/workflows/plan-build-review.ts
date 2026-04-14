import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(ctx.run.runId, stepName, (v: VerdictPayload) => {
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

const planStep: Step = {
  name: "plan",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are being asked to plan the following goal:

GOAL: ${ctx.run.goal}

Please:
1. Analyze the goal and break it into concrete, actionable sub-tasks
2. Identify which files need to be created or modified
3. Note any risks or unknowns
4. Write the plan as a numbered list with clear implementation steps

When your plan is complete, call VerdictEmit with:
- step: "plan"
- verdict: "PASS" (if the goal is feasible and the plan is clear)
- verdict: "FAIL" with issues listed (if the goal is not feasible or you need more information)
- artifacts: ["plan.md"] pointing to the plan file you create`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "planner", prompt, "plan");
      const planArtifact = verdict.artifacts?.[0] ?? "plan.md";
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { plan: planArtifact },
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

const buildStep: Step = {
  name: "build",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["plan"] ?? "No plan artifact found";
    const prompt = `You are the implementer. Here is the plan you need to execute:

PLAN LOCATION: ${planArtifact}

Please:
1. Read the plan file
2. Implement each step in order
3. Write tests alongside implementation (TDD)
4. For any destructive operation (git push, npm install, file delete), call RequestApproval first

When implementation is complete and tests pass, call VerdictEmit with:
- step: "build"
- verdict: "PASS" (implementation complete, tests passing)
- verdict: "FAIL" with specific issues listed (if blocked or tests failing)`;

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
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the reviewer. Please review the implementation for the following goal:

GOAL: ${ctx.run.goal}

Previous steps completed: ${ctx.run.steps.map(s => s.name).join(", ")}

Please:
1. Read all changed/created files
2. Check for logical errors, edge cases, missing tests
3. Verify the implementation matches the plan
4. Look for security issues, performance problems, or maintainability concerns

When your review is complete, call VerdictEmit with:
- step: "review"
- verdict: "PASS" (implementation is correct, complete, and maintainable)
- verdict: "FAIL" with a specific list of issues (what exactly is wrong and where)
- handoffHint: "security" | "perf" | "re-plan" if the issue category warrants specialist escalation`;

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

export const planBuildReview: Workflow = {
  name: "plan-build-review",
  description: "Plan a feature, implement it, then review for correctness.",
  steps: [planStep, buildStep, reviewStep],
  transitions: [
    { from: "plan",   when: (r) => r.verdict === "PASS",   to: "build" },
    { from: "plan",   when: (r) => r.verdict !== "PASS",   to: "halt" },
    { from: "build",  when: (r) => r.verdict === "PASS",   to: "review" },
    { from: "build",  when: (r) => r.verdict !== "PASS",   to: "halt" },
    { from: "review", when: (_r) => true,                  to: "halt" },
  ],
  defaults: {
    maxIterations: 8,
    maxCostUsd: 20,
    maxWallSeconds: 3600,
  },
};
