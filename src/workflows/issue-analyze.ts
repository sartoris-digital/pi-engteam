import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";
import { resolveArtifactPath } from "./helpers.js";

async function waitForVerdict(
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

const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are analyzing an issue.

GOAL: ${ctx.run.goal}

If the goal contains [tracker:<type>], use the indicated CLI to fetch the ticket first.
Otherwise analyze the issue description directly from the goal text.

Required output — write TWO files to the current run directory:
1. analysis.md — classification (severity, type, component), root cause analysis, impact assessment
2. routing-recommendation.md — which workflow should handle this (debug/fix-loop/security-review/etc.), who the likely owner is, recommended next steps

Call VerdictEmit with:
- step: "analyze"
- verdict: "PASS" (both files written)
- verdict: "FAIL" with issues if analysis could not be completed
- artifacts: ["analysis.md", "routing-recommendation.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "issue-analyst", prompt, "analyze");
      const artifacts: Record<string, string> = {
        "analysis": resolveArtifactPath(ctx, verdict.artifacts?.[0], "analysis.md"),
      };
      if (verdict.artifacts?.[1]) {
        artifacts["routing-recommendation"] = resolveArtifactPath(ctx, verdict.artifacts[1], "routing-recommendation.md");
      }
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts,
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const issueAnalyze: Workflow = {
  name: "issue-analyze",
  description: "Fetch an issue ticket and extract structured requirements into issue-brief.md.",
  steps: [analyzeStep],
  transitions: [
    { from: "analyze", when: (_r) => true, to: "halt" },
  ],
  defaults: {
    maxIterations: 3,
    maxCostUsd: 5,
    maxWallSeconds: 3600,
  },
};
