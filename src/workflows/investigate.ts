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

const gatherStep: Step = {
  name: "gather",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `GOAL / INCIDENT: ${ctx.run.goal}

Retrieve all relevant context: code paths, recent commits, configuration, logs, ADRs related to this incident. Write a context-pack.md. Call VerdictEmit with step="gather".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "knowledge-retriever", prompt, "gather");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        // C4: stable "context" key so analyzeStep can always find it
        artifacts: { "context": verdict.artifacts?.[0] ?? "context-pack.md" },
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

const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `INCIDENT: ${ctx.run.goal}
CONTEXT PACK: ${ctx.run.artifacts["context"] ?? "See context-pack.md"}

Build a timeline and probability-ranked hypothesis tree. Write an incident-report.md. Call VerdictEmit with step="analyze".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "incident-investigator", prompt, "analyze");
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

const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const previousFeedback = [...ctx.run.steps].reverse().find(s => s.name === "judge-gate")?.issues;
    const feedbackSection = previousFeedback
      ? `\nPREVIOUS JUDGE FEEDBACK:\n${previousFeedback.join("\n")}`
      : "";

    const prompt = `INCIDENT: ${ctx.run.goal}
HYPOTHESIS TREE: See incident-report.md

Review the investigation findings. If the hypothesis tree is well-evidenced and actionable, PASS. If it needs deeper investigation, FAIL with specific gaps to address.${feedbackSection}

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

export const investigate: Workflow = {
  name: "investigate",
  description: "Gather incident context, build a hypothesis tree, and gate on judge review.",
  steps: [gatherStep, analyzeStep, judgeGateStep],
  transitions: [
    { from: "gather",     when: (r) => r.verdict === "PASS",  to: "analyze" },
    { from: "gather",     when: (r) => r.verdict !== "PASS",  to: "halt" },
    { from: "analyze",    when: (r) => r.verdict === "PASS",  to: "judge-gate" },
    { from: "analyze",    when: (r) => r.verdict !== "PASS",  to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS",  to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS",  to: "analyze" },
  ],
  defaults: {
    maxIterations: 6,
    maxCostUsd: 15,
    maxWallSeconds: 1800,
  },
};
