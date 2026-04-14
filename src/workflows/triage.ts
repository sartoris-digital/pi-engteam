import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const softReminder = setTimeout(() => {
      ctx.team.deliver(agentName, {
        id: crypto.randomUUID(),
        from: "system",
        to: agentName,
        summary: `Reminder: step ${stepName} nearing timeout`,
        message: `You have 2 minutes remaining to emit a verdict for step "${stepName}". Call VerdictEmit now.`,
        ts: new Date().toISOString(),
      }).catch(() => {});
    }, 8 * 60 * 1000);

    const timeout = setTimeout(() => {
      clearTimeout(softReminder);
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(ctx.run.runId, stepName, (v: VerdictPayload) => {
      clearTimeout(softReminder);
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

const classifyStep: Step = {
  name: "classify",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `BUG REPORT: ${ctx.run.goal}

Classify this bug: assign P0-P3 severity, identify the owner area (security/performance/regression/ux/infra), and check for duplicates in the codebase. Write a triage summary. Call VerdictEmit with step="classify".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "bug-triage", prompt, "classify");
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

const routeStep: Step = {
  name: "route",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `BUG: ${ctx.run.goal}
CLASSIFICATION: See previous classify step output.

Write a routing recommendation: which workflow should handle this (debug/fix-loop/security-review/etc.), who the likely owner is, and what the SLA should be. Call VerdictEmit with step="route".`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "bug-triage", prompt, "route");
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
      ? `\nPREVIOUS FEEDBACK:\n${previousFeedback.join("\n")}`
      : "";

    const prompt = `BUG: ${ctx.run.goal}

Review the triage and routing. Confirm or override severity and routing.${feedbackSection}

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

export const triage: Workflow = {
  name: "triage",
  description: "Classify a bug report, write a routing recommendation, then gate on judge confirmation.",
  steps: [classifyStep, routeStep, judgeGateStep],
  transitions: [
    { from: "classify",   when: (r) => r.verdict === "PASS",  to: "route" },
    { from: "classify",   when: (r) => r.verdict !== "PASS",  to: "halt" },
    { from: "route",      when: (r) => r.verdict === "PASS",  to: "judge-gate" },
    { from: "route",      when: (r) => r.verdict !== "PASS",  to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS",  to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS",  to: "classify" },
  ],
  defaults: {
    maxIterations: 5,
    maxCostUsd: 5,
    maxWallSeconds: 600,
  },
};
