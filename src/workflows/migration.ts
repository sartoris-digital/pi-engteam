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

const planStep: Step = {
  name: "plan",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const securityFeedback =
      ctx.run.steps.findLast(s => s.name === "security-review")?.issues?.join("\n") ?? "";
    const judgeFeedback =
      ctx.run.steps.findLast(s => s.name === "judge-gate")?.issues?.join("\n") ?? "";

    const feedbackSection = [
      securityFeedback ? `\nSECURITY REVIEW FEEDBACK:\n${securityFeedback}` : "",
      judgeFeedback ? `\nJUDGE FEEDBACK:\n${judgeFeedback}` : "",
    ].filter(Boolean).join("\n");

    const prompt = `You are an architect designing a database migration.

GOAL: ${ctx.run.goal}
${feedbackSection}

Please:
1. Design the schema changes (tables, columns, indexes, constraints)
2. Define a rollback strategy for each change
3. List data transformation steps in order
4. Identify risks (data loss, locking, constraint violations)
5. Produce a migration plan document

When complete, call VerdictEmit with:
- step: "plan"
- verdict: "PASS" (if the migration is safe and the plan is clear)
- verdict: "FAIL" with issues listed (if the goal is not feasible or needs clarification)
- artifacts: ["migration-plan.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "architect", prompt, "plan");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { "migration-plan": verdict.artifacts?.[0] ?? "migration-plan.md" },
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

const securityReviewStep: Step = {
  name: "security-review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["migration-plan"] ?? "migration-plan.md";
    const prompt = `You are a security auditor reviewing a database migration plan.

GOAL: ${ctx.run.goal}
MIGRATION PLAN: ${planArtifact}

Audit for:
1. Data exposure risks (PII columns, unencrypted sensitive data)
2. Privilege escalation (excessive grants, role changes)
3. Unsafe column drops (data loss without backup)
4. Missing rollback coverage
5. SQL injection vectors in transformation scripts

When complete, call VerdictEmit with:
- step: "security-review"
- verdict: "PASS" (migration is safe to implement)
- verdict: "FAIL" with specific issues listed (security problems found)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "security-auditor", prompt, "security-review");
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

const implementStep: Step = {
  name: "implement",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["migration-plan"] ?? "migration-plan.md";
    const prompt = `You are the implementer writing database migration scripts.

GOAL: ${ctx.run.goal}
MIGRATION PLAN: ${planArtifact}

Please:
1. Write the up migration script (forward migration)
2. Write the down migration script (rollback)
3. Include data transformation steps from the plan
4. Add comments explaining each change
5. Ensure idempotency where possible

When complete, call VerdictEmit with:
- step: "implement"
- verdict: "PASS" (scripts are written and ready for testing)
- verdict: "FAIL" with issues listed (if blocked)
- artifacts: ["migrations/up.sql", "migrations/down.sql"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "implement");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
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

const testStep: Step = {
  name: "test",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["migration-plan"] ?? "migration-plan.md";
    const prompt = `You are a tester verifying database migration scripts.

GOAL: ${ctx.run.goal}
MIGRATION PLAN: ${planArtifact}

Please:
1. Run the up migration against a test database
2. Verify schema changes match the plan
3. Run the down migration (rollback)
4. Verify the schema is restored to its pre-migration state
5. Check for data integrity after both directions

When complete, call VerdictEmit with:
- step: "test"
- verdict: "PASS" (migration runs cleanly, rollback works)
- verdict: "FAIL" with specific failures listed (migration errors, rollback failures, data corruption)`;

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

const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["migration-plan"] ?? "migration-plan.md";
    const prompt = `You are the judge reviewing a database migration for production approval.

GOAL: ${ctx.run.goal}
MIGRATION PLAN: ${planArtifact}

Previous steps completed: ${ctx.run.steps.map(s => s.name).join(", ")}

Review:
1. Migration plan completeness and clarity
2. Security review was PASS
3. Test results confirm up and down migrations work
4. Risk level is acceptable for production

When complete, call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" (migration approved for production)
- verdict: "FAIL" with issues listed (requires re-planning)`;

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

export const migration: Workflow = {
  name: "migration",
  description: "Plan, security-review, implement, test, and judge-gate a database migration.",
  steps: [planStep, securityReviewStep, implementStep, testStep, judgeGateStep],
  transitions: [
    { from: "plan",            when: (r) => r.verdict === "PASS", to: "security-review" },
    { from: "plan",            when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "security-review", when: (r) => r.verdict === "PASS", to: "implement" },
    { from: "security-review", when: (r) => r.verdict !== "PASS", to: "plan" },
    { from: "implement",       when: (r) => r.verdict === "PASS", to: "test" },
    // H4: implementation blockers should feed back into planning instead of halting
    { from: "implement",       when: (r) => r.verdict !== "PASS", to: "plan" },
    { from: "test",            when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "test",            when: (r) => r.verdict !== "PASS", to: "implement" },
    { from: "judge-gate",      when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate",      when: (r) => r.verdict !== "PASS", to: "plan" },
  ],
  defaults: {
    maxIterations: 8,
    maxCostUsd: 25,
    maxWallSeconds: 3600,
  },
};
