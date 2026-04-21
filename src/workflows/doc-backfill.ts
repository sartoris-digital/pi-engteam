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

Scan for undocumented public functions/classes (missing JSDoc), modules without READMEs, and ADR gaps.
Write a summary of all gaps found to doc-audit-gaps.md.
- If gaps found: list them, call VerdictEmit step="audit" verdict="PASS"
- If NO gaps found: call VerdictEmit step="audit" verdict="PASS" handoffHint="no-docs-needed"`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "knowledge-retriever", prompt, "audit");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        // M6: stable "audit-findings" key so planStep can reference the gap list
        artifacts: { "audit-findings": verdict.artifacts?.[0] ?? "doc-audit-gaps.md" },
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

const planStep: Step = {
  name: "plan",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are a planner producing a prioritized documentation backfill list.

GOAL: ${ctx.run.goal}
AUDIT FINDINGS: ${ctx.run.artifacts["audit-findings"] ?? "doc-audit-gaps.md"}

The audit step has identified documentation gaps. Please:
1. Read the audit findings file
2. Prioritize gaps by impact (public APIs first, then modules, then ADRs)
3. Estimate effort for each item
4. Produce a prioritized backfill plan with clear ownership

When complete, call VerdictEmit with:
- step: "plan"
- verdict: "PASS" (backfill plan is ready)
- verdict: "FAIL" with issues listed (if the plan cannot be formed)
- artifacts: ["doc-backfill-plan.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "planner", prompt, "plan");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { "doc-backfill-plan": verdict.artifacts?.[0] ?? "doc-backfill-plan.md" },
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

const writeStep: Step = {
  name: "write",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["doc-backfill-plan"] ?? "doc-backfill-plan.md";
    const reviewIssues =
      ctx.run.steps.findLast(s => s.name === "review")?.issues?.join("\n") ?? "";

    const prompt = `You are the implementer writing documentation.

GOAL: ${ctx.run.goal}
BACKFILL PLAN: ${planArtifact}
${reviewIssues ? `\nREVIEWER ISSUES:\n${reviewIssues}` : ""}

Please:
1. Write JSDoc/TSDoc for all undocumented public functions and classes
2. Create READMEs for modules missing them
3. Write ADRs for architectural decisions that lack documentation
4. Follow existing documentation style and conventions

When complete, call VerdictEmit with:
- step: "write"
- verdict: "PASS" (all documentation written)
- verdict: "FAIL" with issues listed (if blocked)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "write");
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
    const prompt = `You are a reviewer validating documentation accuracy.

GOAL: ${ctx.run.goal}

Please:
1. Check each JSDoc/TSDoc comment against the actual implementation
2. Verify READMEs accurately describe their modules
3. Confirm ADRs reflect actual architectural decisions
4. Flag inaccuracies, missing parameters, incorrect return types, or misleading descriptions

When complete, call VerdictEmit with:
- step: "review"
- verdict: "PASS" (documentation is accurate and complete)
- verdict: "FAIL" with a specific list of inaccuracies (what is wrong and where)`;

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
    const prompt = `You are the judge approving a documentation backfill.

GOAL: ${ctx.run.goal}

Previous steps completed: ${ctx.run.steps.map(s => s.name).join(", ")}

Review:
1. All identified gaps from the audit are addressed
2. Documentation is accurate (reviewer PASS)
3. Style is consistent with the existing codebase
4. ADRs capture the right decisions

When complete, call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" (documentation approved)
- verdict: "FAIL" with issues listed (requires revision)`;

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

export const docBackfill: Workflow = {
  name: "doc-backfill",
  description: "Audit, plan, write, review, and judge-gate a documentation backfill.",
  steps: [auditStep, planStep, writeStep, reviewStep, judgeGateStep],
  transitions: [
    { from: "audit",      when: (r) => r.verdict === "PASS" && r.handoffHint !== "no-docs-needed", to: "plan" },
    { from: "audit",      when: (r) => r.verdict === "PASS" && r.handoffHint === "no-docs-needed", to: "halt" },
    { from: "audit",      when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "plan",       when: (r) => r.verdict === "PASS", to: "write" },
    { from: "plan",       when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "write",      when: (r) => r.verdict === "PASS", to: "review" },
    // M3: loop back to plan on write failure so planner can adjust for blockers
    { from: "write",      when: (r) => r.verdict !== "PASS", to: "plan" },
    { from: "review",     when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "review",     when: (r) => r.verdict !== "PASS", to: "write" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS", to: "write" },
  ],
  defaults: {
    maxIterations: 7,
    maxCostUsd: 15,
    maxWallSeconds: 3600,
  },
};
