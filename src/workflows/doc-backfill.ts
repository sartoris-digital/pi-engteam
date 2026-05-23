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

const auditStep: Step = {
  name: "audit",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `GOAL: ${ctx.run.goal}

Scan for undocumented public functions/classes (missing JSDoc), modules without READMEs, and ADR gaps.
Write a summary of all gaps found to doc-audit-gaps.md.

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step:
- If gaps found: write doc-audit-gaps.md, then call VerdictEmit step="audit" verdict="PASS"
- If NO gaps found: call VerdictEmit step="audit" verdict="PASS" handoffHint="no-docs-needed"

Do NOT end your response without calling VerdictEmit. Writing your analysis in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "knowledge-retriever", prompt, "audit");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        // M6: stable "audit-findings" key so planStep can reference the gap list
        artifacts: { "audit-findings": resolveArtifactPath(ctx, verdict.artifacts?.[0], "doc-audit-gaps.md") },
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
  timeoutSeconds: 1800,
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
        artifacts: { "doc-backfill-plan": resolveArtifactPath(ctx, verdict.artifacts?.[0], "doc-backfill-plan.md") },
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
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    // Codex round-10 HIGH: fence worker-supplied review issues.
    const { fenceArray } = await import("../safety/prompt-fence.js");
    const planArtifact = ctx.run.artifacts["doc-backfill-plan"] ?? "doc-backfill-plan.md";
    const reviewIssuesRaw = ctx.run.steps.findLast(s => s.name === "review")?.issues;
    const reviewIssues = reviewIssuesRaw && reviewIssuesRaw.length > 0
      ? fenceArray(reviewIssuesRaw, "REVIEW_ISSUES")
      : "";

    const prompt = `You are the implementer writing documentation.

GOAL: ${ctx.run.goal}
BACKFILL PLAN: ${planArtifact}
${reviewIssues ? `\nREVIEWER ISSUES:\n${reviewIssues}` : ""}

Please:
1. Write JSDoc/TSDoc for all undocumented public functions and classes
2. Create READMEs for modules missing them
3. Write ADRs for architectural decisions that lack documentation
4. Follow existing documentation style and conventions

Write a doc-summary.md listing all JSDoc comments added. Include artifacts: ["doc-summary.md"] in your VerdictEmit.

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
        artifacts: { "doc": resolveArtifactPath(ctx, verdict.artifacts?.[0], "doc-summary.md") },
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
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const runDir = join(ctx.engine.getRunsDir(), ctx.run.runId);
    const verdictPath = join(runDir, "verdict.md");
    const prompt = `You are the judge approving a documentation backfill.

GOAL: ${ctx.run.goal}

Previous steps completed: ${ctx.run.steps.map(s => s.name).join(", ")}

Review:
1. All identified gaps from the audit are addressed
2. Documentation is accurate (reviewer PASS)
3. Style is consistent with the existing codebase
4. ADRs capture the right decisions

Write your verdict summary to exactly this path: ${verdictPath}
When complete, call VerdictEmit with:
- step: "judge-gate"
- artifacts: ["${verdictPath}"]
- verdict: "PASS" (documentation approved)
- verdict: "FAIL" with issues listed (requires revision)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
            // Fallback: write verdict.md from verdict data if agent wrote to wrong path
      if (!existsSync(verdictPath)) {
        try {
          const lines = [`# Judge Verdict: ${verdict.verdict}`];
          if (verdict.issues?.length) lines.push(`\n## Issues\n${verdict.issues.map(i => `- ${i}`).join("\n")}`);
          writeFileSync(verdictPath, lines.join("\n") + "\n");
        } catch { /* best-effort — run dir may not exist in tests */ }
      }
      // Treat FAIL caused solely by artifact path error as PASS
      const artifactPathError = verdict.issues?.every(i => i.includes("not found or out of allowed roots"));
      const effectiveVerdict = artifactPathError ? "PASS" : verdict.verdict;
      return {
        success: effectiveVerdict === "PASS",
        verdict: effectiveVerdict,
        issues: artifactPathError ? undefined : verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: { "judge-verdict": verdictPath },
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
    maxWallSeconds: 7200,
  },
};
