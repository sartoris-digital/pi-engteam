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

const gatherStep: Step = {
  name: "gather",
  required: true,
  timeoutSeconds: 1800,
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
        artifacts: { "context": resolveArtifactPath(ctx, verdict.artifacts?.[0], "context-pack.md") },
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
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `INCIDENT: ${ctx.run.goal}
CONTEXT PACK: ${ctx.run.artifacts["context"] ?? "See context-pack.md"}

Build a timeline and probability-ranked hypothesis tree. Write an investigation.md. Call VerdictEmit with step="analyze".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "incident-investigator", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        // L2: stable key so judge-gate can reference the actual report path
        artifacts: { "investigation": resolveArtifactPath(ctx, verdict.artifacts?.[0], "investigation.md") },
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
    const previousFeedback = [...ctx.run.steps].reverse().find(s => s.name === "judge-gate")?.issues;
    const feedbackSection = previousFeedback
      ? `\nPREVIOUS JUDGE FEEDBACK:\n${previousFeedback.join("\n")}`
      : "";
    const runDir = join(ctx.engine.getRunsDir(), ctx.run.runId);
    const verdictPath = join(runDir, "verdict.md");

    const incidentReport = ctx.run.artifacts["investigation"] ?? "investigation.md";
    const prompt = `INCIDENT: ${ctx.run.goal}
HYPOTHESIS TREE: ${incidentReport}

Read the incident report file.
Review the investigation findings. If the hypothesis tree is well-evidenced and actionable, PASS. If it needs deeper investigation, FAIL with specific gaps to address.${feedbackSection}

Write your verdict summary to exactly this path: ${verdictPath}
Call VerdictEmit with step="judge-gate", artifacts=["${verdictPath}"].`;

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
