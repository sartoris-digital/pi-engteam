import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";
import { readRecentEntries, formatPrelude } from "../adw/ConversationProjection.js";

const CONVERSATION_PRELUDE_LIMIT = 50;

const LEAD_SHORT: Record<string, "eng" | "valid" | "invest"> = {
  "engineering-lead": "eng",
  "validation-lead": "valid",
  "investigation-lead": "invest",
};

async function dispatch(ctx: StepContext, agentName: string, prompt: string, stepName: string): Promise<VerdictPayload> {
  const verdict = await ctx.team.deliver(agentName, {
    id: crypto.randomUUID(),
    from: "system",
    to: agentName,
    summary: `Consult step: ${stepName}`,
    message: prompt,
    ts: new Date().toISOString(),
  });
  if (!verdict) {
    throw new Error(`Agent ${agentName} did not emit verdict for step ${stepName}`);
  }
  return verdict;
}

async function preludeFor(ctx: StepContext): Promise<string> {
  const runDir = join(ctx.engine.getRunsDir(), ctx.run.runId);
  const recent = await readRecentEntries(runDir, CONVERSATION_PRELUDE_LIMIT);
  return formatPrelude(recent);
}

const dispatchStep: Step = {
  name: "dispatch",
  required: true,
  agent: "orchestrator",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prelude = await preludeFor(ctx);
    const teams = (ctx.run as any).consultTeams ?? ["engineering-lead", "validation-lead", "investigation-lead"];
    const prompt = [
      prelude,
      `You are the orchestrator coordinating a cross-team adversarial review.`,
      ``,
      `TOPIC: ${ctx.run.goal}`,
      `PARTICIPATING TEAMS: ${teams.join(", ")}`,
      ``,
      `Your job in this step:`,
      `1. Restate the topic precisely so each Lead understands the question.`,
      `2. Note any framing decisions (scope, constraints) the Leads should respect.`,
      `3. Acknowledge that each Lead will independently write a position file at <run>/positions/<lead>.md.`,
      ``,
      `Call VerdictEmit with step="dispatch", verdict="PASS".`,
    ].join("\n");
    try {
      const verdict = await dispatch(ctx, "orchestrator", prompt, "dispatch");
      return { success: verdict.verdict === "PASS", verdict: verdict.verdict, issues: verdict.issues };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

function makePositionStep(leadAgent: string): Step {
  const short = LEAD_SHORT[leadAgent];
  return {
    name: `position-${short}`,
    required: true,
    agent: leadAgent,
    dependsOn: ["dispatch"],
    run: async (ctx: StepContext): Promise<StepResult> => {
      const prelude = await preludeFor(ctx);
      const positionsDir = `<run>/positions`;
      const filePath = `${positionsDir}/${leadAgent}.md`;
      const prompt = [
        prelude,
        `You are ${leadAgent}. Cross-team consult: write your team's position on the topic.`,
        ``,
        `TOPIC: ${ctx.run.goal}`,
        ``,
        `Your job:`,
        `1. Read <run>/conversation.jsonl for the dispatch framing.`,
        `2. Optionally consult your domain workers via SendMessage.`,
        `3. Write your team's specialty take to ${filePath}. Cover: assumptions, recommendations, risks specific to your domain, blind spots you see in adjacent teams.`,
        `4. Be concrete. Cite specific files, tests, or behaviors when possible.`,
        ``,
        `Call VerdictEmit with step="position", verdict="PASS", artifacts=["${filePath}"].`,
      ].join("\n");
      try {
        const verdict = await dispatch(ctx, leadAgent, prompt, `position-${short}`);
        return {
          success: verdict.verdict === "PASS",
          verdict: verdict.verdict,
          issues: verdict.issues,
          artifacts: { [`position-${short}`]: verdict.artifacts?.[0] ?? `positions/${leadAgent}.md` },
        };
      } catch (err) {
        return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function makeAdversarialStep(leadAgent: string): Step {
  const short = LEAD_SHORT[leadAgent];
  return {
    name: `adversarial-${short}`,
    required: true,
    agent: leadAgent,
    dependsOn: ["position-eng", "position-valid", "position-invest"],
    run: async (ctx: StepContext): Promise<StepResult> => {
      const prelude = await preludeFor(ctx);
      const filePath = `<run>/adversarial/${leadAgent}.md`;
      const prompt = [
        prelude,
        `You are ${leadAgent}. Adversarial round: critique your peers.`,
        ``,
        `TOPIC: ${ctx.run.goal}`,
        ``,
        `Read every position file in <run>/positions/ — including your own. Then write ${filePath} containing:`,
        `- Explicit pushback on each peer's position. Where do you disagree, and why?`,
        `- Risks they missed.`,
        `- Blind spots in their framing.`,
        `- One question per peer that, if answered, would either change their position or yours.`,
        ``,
        `Be direct, not polite. The goal is friction that exposes weak claims.`,
        ``,
        `Call VerdictEmit with step="adversarial", verdict="PASS", artifacts=["${filePath}"].`,
      ].join("\n");
      try {
        const verdict = await dispatch(ctx, leadAgent, prompt, `adversarial-${short}`);
        return {
          success: verdict.verdict === "PASS",
          verdict: verdict.verdict,
          issues: verdict.issues,
          artifacts: { [`adversarial-${short}`]: verdict.artifacts?.[0] ?? `adversarial/${leadAgent}.md` },
        };
      } catch (err) {
        return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const synthesisStep: Step = {
  name: "synthesis",
  required: true,
  agent: "orchestrator",
  dependsOn: ["adversarial-eng", "adversarial-valid", "adversarial-invest"],
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prelude = await preludeFor(ctx);
    const filePath = `<run>/synthesis.md`;
    const prompt = [
      prelude,
      `You are the orchestrator. Final synthesis step.`,
      ``,
      `TOPIC: ${ctx.run.goal}`,
      ``,
      `Read every file in <run>/positions/ and <run>/adversarial/. Then write ${filePath} with these sections:`,
      `## Areas of agreement`,
      `## Contested points`,
      `## Recommended path forward`,
      `## Deferred decisions`,
      ``,
      `Be terse. No filler. Quote specific positions/critiques where they matter.`,
      ``,
      `Call VerdictEmit with step="synthesis", verdict="PASS", artifacts=["${filePath}"].`,
    ].join("\n");
    try {
      const verdict = await dispatch(ctx, "orchestrator", prompt, "synthesis");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { synthesis: verdict.artifacts?.[0] ?? "synthesis.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const consult: Workflow = {
  name: "consult",
  description: "Cross-team adversarial review: positions, pushback, synthesis.",
  steps: [
    dispatchStep,
    makePositionStep("engineering-lead"),
    makePositionStep("validation-lead"),
    makePositionStep("investigation-lead"),
    makeAdversarialStep("engineering-lead"),
    makeAdversarialStep("validation-lead"),
    makeAdversarialStep("investigation-lead"),
    synthesisStep,
  ],
  transitions: [
    { from: "dispatch", when: () => true, to: "halt" },
    { from: "synthesis", when: () => true, to: "halt" },
  ],
  defaults: {
    maxIterations: 10,
    maxCostUsd: 25,
    maxWallSeconds: 1800,
  },
};

/**
 * Build a customized consult workflow filtered by selected lead short-names.
 * Defaults to the full 3-team layout when teams is undefined or empty.
 *
 * Codex round-4 H-2: accepts an optional workflowName so each /consult
 * invocation registers a uniquely-named workflow (typically `consult-<runId>`).
 * Without this, a second /consult invocation with a different team subset
 * would overwrite the first registration under the shared name "consult",
 * silently changing the DAG of any in-flight run.
 */
export function buildConsultWorkflow(
  teams?: Array<"eng" | "valid" | "invest">,
  workflowName?: string,
): Workflow {
  const selected = teams && teams.length > 0 ? teams : ["eng", "valid", "invest"];
  const leadFor = (s: string): string => {
    if (s === "eng") return "engineering-lead";
    if (s === "valid") return "validation-lead";
    return "investigation-lead";
  };
  const leads = selected.map(leadFor);
  const positionSteps = leads.map(makePositionStep);
  const positionNames = selected.map((s) => `position-${s}`);
  const adversarialSteps = leads.map((lead) => ({
    ...makeAdversarialStep(lead),
    dependsOn: positionNames,
  }));
  const adversarialNames = selected.map((s) => `adversarial-${s}`);
  const synth: Step = { ...synthesisStep, dependsOn: adversarialNames };
  return {
    ...consult,
    name: workflowName ?? consult.name,
    steps: [dispatchStep, ...positionSteps, ...adversarialSteps, synth],
  };
}

/**
 * Initialize the conversation projection and write helper files for a consult run.
 * Called by the /consult shortcut before execution begins.
 */
export async function bootstrapConsultRun(runDir: string): Promise<void> {
  await mkdir(join(runDir, "positions"), { recursive: true });
  await mkdir(join(runDir, "adversarial"), { recursive: true });
  // Touch the conversation file so leads can read it even before the first event flushes.
  await writeFile(join(runDir, "conversation.jsonl"), "", { flag: "a" });
}
