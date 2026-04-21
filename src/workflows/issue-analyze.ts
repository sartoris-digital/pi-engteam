import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

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
  });
  if (!verdict) {
    throw new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within timeout`);
  }
  return verdict;
}

const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are analyzing an issue ticket.

GOAL: ${ctx.run.goal}

The goal string ends with [tracker:<type>] indicating which CLI to use.
Fetch the ticket, extract requirements, and write issue-brief.md to the current run directory.

Call VerdictEmit with:
- step: "analyze"
- verdict: "PASS" (issue-brief.md written with all required sections)
- verdict: "FAIL" with issues (CLI not found, ticket not found, tracker unknown after all detection attempts)
- artifacts: ["issue-brief.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "issue-analyst", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { "issue-brief": verdict.artifacts?.[0] ?? "issue-brief.md" },
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
    maxCostUsd: 2,
    maxWallSeconds: 600,
  },
};
