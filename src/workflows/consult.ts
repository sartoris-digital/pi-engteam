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
  // Round-4 H1: pass stepName explicitly via opts.hostStep so parallel
  // sibling deliveries (e.g. position-eng + position-valid + position-invest
  // running concurrently) don't share a mutable currentStepName field.
  const verdict = await ctx.team.deliver(
    agentName,
    {
      id: crypto.randomUUID(),
      from: "system",
      to: agentName,
      summary: `Consult step: ${stepName}`,
      message: prompt,
      ts: new Date().toISOString(),
    },
    { hostStep: stepName },
  );
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

// Phase 6: multi-round consult. Round 1 keeps the legacy step/file
// naming (`position-eng`, `positions/engineering-lead.md`) for backward
// compat. Rounds ≥ 2 append `-rN` and the round-N file suffix is
// `-rN.md` so each round's artifacts coexist on disk.
function roundSuffix(round: number): string {
  return round <= 1 ? "" : `-r${round}`;
}

function positionStepName(short: string, round: number): string {
  return `position-${short}${roundSuffix(round)}`;
}

function adversarialStepName(short: string, round: number): string {
  return `adversarial-${short}${roundSuffix(round)}`;
}

function positionFilePath(leadAgent: string, round: number): string {
  return `<run>/positions/${leadAgent}${roundSuffix(round)}.md`;
}

function adversarialFilePath(leadAgent: string, round: number): string {
  return `<run>/adversarial/${leadAgent}${roundSuffix(round)}.md`;
}

function makePositionStep(leadAgent: string, round: number = 1, allShorts?: string[]): Step {
  const short = LEAD_SHORT[leadAgent];
  const stepName = positionStepName(short, round);
  const filePath = positionFilePath(leadAgent, round);
  // Round 1 depends on dispatch. Round N>1 depends on every Lead's
  // round-(N-1) adversarial so revisions read the latest critiques.
  const dependsOn = round === 1
    ? ["dispatch"]
    : (allShorts ?? ["eng", "valid", "invest"]).map((s) => adversarialStepName(s, round - 1));
  return {
    name: stepName,
    required: true,
    agent: leadAgent,
    dependsOn,
    run: async (ctx: StepContext): Promise<StepResult> => {
      const prelude = await preludeFor(ctx);
      const promptLines: string[] = [prelude];
      if (round === 1) {
        promptLines.push(
          `You are ${leadAgent}. Cross-team consult (round 1): write your team's position on the topic.`,
          ``,
          `TOPIC: ${ctx.run.goal}`,
          ``,
          `Your job:`,
          `1. Read <run>/conversation.jsonl for the dispatch framing.`,
          `2. Optionally consult your domain workers via SendMessage.`,
          `3. Write your team's specialty take to ${filePath}. Cover: assumptions, recommendations, risks specific to your domain, blind spots you see in adjacent teams.`,
          `4. Be concrete. Cite specific files, tests, or behaviors when possible.`,
          ``,
          `Call VerdictEmit with step="${stepName}", verdict="PASS", artifacts=["${filePath}"].`,
        );
      } else {
        const priorAdvPaths = (allShorts ?? ["eng", "valid", "invest"]).map((s) => {
          const lead = s === "eng" ? "engineering-lead" : s === "valid" ? "validation-lead" : "investigation-lead";
          return adversarialFilePath(lead, round - 1);
        });
        const priorOwnPos = positionFilePath(leadAgent, round - 1);
        promptLines.push(
          `You are ${leadAgent}. Consult round ${round}: REVISE your position in light of round ${round - 1}'s adversarial critiques.`,
          ``,
          `TOPIC: ${ctx.run.goal}`,
          ``,
          `Your job:`,
          `1. Read your round-${round - 1} position: ${priorOwnPos}`,
          `2. Read every peer's round-${round - 1} adversarial:`,
          ...priorAdvPaths.map((p) => `   - ${p}`),
          `3. Decide what changes. Concede where a critique landed. Sharpen where you stand by your prior position. Be explicit about which round-${round - 1} points you're addressing.`,
          `4. Write the revised position to ${filePath}. Lead with "Changes from round ${round - 1}" so the diff is visible at a glance, then the full revised position.`,
          ``,
          `Call VerdictEmit with step="${stepName}", verdict="PASS", artifacts=["${filePath}"].`,
        );
      }
      const prompt = promptLines.join("\n");
      try {
        const verdict = await dispatch(ctx, leadAgent, prompt, stepName);
        // Round-2 H1: only record the position artifact path on PASS.
        // Recording a fallback path on FAIL/NEEDS_MORE pollutes the
        // run state with a file that was never written; downstream
        // adversarial/synthesis prompts then reference a non-existent
        // file and either silently use stale data or emit confused FAIL.
        const isPass = verdict.verdict === "PASS";
        return {
          success: isPass,
          verdict: verdict.verdict,
          issues: verdict.issues,
          artifacts: isPass
            ? { [stepName]: verdict.artifacts?.[0] ?? `positions/${leadAgent}${roundSuffix(round)}.md` }
            : undefined,
        };
      } catch (err) {
        return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function makeAdversarialStep(leadAgent: string, round: number = 1, allShorts?: string[]): Step {
  const short = LEAD_SHORT[leadAgent];
  const stepName = adversarialStepName(short, round);
  const filePath = adversarialFilePath(leadAgent, round);
  // Always depends on the same round's positions (all leads).
  const dependsOn = (allShorts ?? ["eng", "valid", "invest"]).map((s) => positionStepName(s, round));
  return {
    name: stepName,
    required: true,
    agent: leadAgent,
    dependsOn,
    run: async (ctx: StepContext): Promise<StepResult> => {
      const prelude = await preludeFor(ctx);
      const positionPaths = (allShorts ?? ["eng", "valid", "invest"]).map((s) => {
        const lead = s === "eng" ? "engineering-lead" : s === "valid" ? "validation-lead" : "investigation-lead";
        return positionFilePath(lead, round);
      });
      const prompt = [
        prelude,
        `You are ${leadAgent}. Adversarial round ${round}: critique your peers' round-${round} positions.`,
        ``,
        `TOPIC: ${ctx.run.goal}`,
        ``,
        `Read every round-${round} position:`,
        ...positionPaths.map((p) => `- ${p}`),
        ``,
        `Then write ${filePath} containing:`,
        `- Explicit pushback on each peer's position. Where do you disagree, and why?`,
        `- Risks they missed.`,
        `- Blind spots in their framing.`,
        `- One question per peer that, if answered, would either change their position or yours.`,
        ...(round > 1 ? [`- A note on which round-${round - 1} critiques each peer ADDRESSED in their revision — call out the strong concessions, and where peers held firm despite earlier pushback.`] : []),
        ``,
        `Be direct, not polite. The goal is friction that exposes weak claims.`,
        ``,
        `Call VerdictEmit with step="${stepName}", verdict="PASS", artifacts=["${filePath}"].`,
      ].join("\n");
      try {
        const verdict = await dispatch(ctx, leadAgent, prompt, stepName);
        // Round-2 H1: only record on PASS so failed adversarial steps
        // don't leave bogus artifact paths in run state.
        const isPass = verdict.verdict === "PASS";
        return {
          success: isPass,
          verdict: verdict.verdict,
          issues: verdict.issues,
          artifacts: isPass
            ? { [stepName]: verdict.artifacts?.[0] ?? `adversarial/${leadAgent}${roundSuffix(round)}.md` }
            : undefined,
        };
      } catch (err) {
        return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function makeSynthesisStep(rounds: number, allShorts: string[]): Step {
  // Synthesis depends on the LAST round's adversarials (which depend on
  // the last round's positions, which transitively pull in every prior
  // round). The orchestrator reads ALL round files when composing the
  // final synthesis.
  const lastRoundAdversarials = allShorts.map((s) => adversarialStepName(s, rounds));
  return {
    name: "synthesis",
    required: true,
    agent: "orchestrator",
    dependsOn: lastRoundAdversarials,
    run: async (ctx: StepContext): Promise<StepResult> => {
      const prelude = await preludeFor(ctx);
      const filePath = `<run>/synthesis.md`;
      const roundsNote = rounds === 1
        ? `Read every file in <run>/positions/ and <run>/adversarial/.`
        : `Read every file in <run>/positions/ and <run>/adversarial/. Note that ${rounds} rounds were run; files without a round suffix are round 1; "-r2"/"-r3"/… suffixes are later rounds. Track how positions EVOLVED across rounds — concessions, persistent disagreements, points that hardened.`;
      const prompt = [
        prelude,
        `You are the orchestrator. Final synthesis step (after ${rounds} round${rounds === 1 ? "" : "s"}).`,
        ``,
        `TOPIC: ${ctx.run.goal}`,
        ``,
        roundsNote,
        ``,
        `Write ${filePath} with these sections:`,
        `## Areas of agreement`,
        `## Contested points`,
        ...(rounds > 1 ? [`## How positions evolved across rounds`] : []),
        `## Recommended path forward`,
        `## Deferred decisions`,
        ``,
        `Be terse. No filler. Quote specific positions/critiques where they matter.`,
        ``,
        `Call VerdictEmit with step="synthesis", verdict="PASS", artifacts=["${filePath}"].`,
      ].join("\n");
      try {
        const verdict = await dispatch(ctx, "orchestrator", prompt, "synthesis");
        const isPass = verdict.verdict === "PASS";
        return {
          success: isPass,
          verdict: verdict.verdict,
          issues: verdict.issues,
          artifacts: isPass
            ? { synthesis: verdict.artifacts?.[0] ?? "synthesis.md" }
            : undefined,
        };
      } catch (err) {
        return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// Backwards-compatible single-round synthesis used by the default
// `consult` workflow export (whose step list is now informational; the
// real DAG is constructed via buildConsultWorkflow).
const synthesisStep: Step = makeSynthesisStep(1, ["eng", "valid", "invest"]);

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
/**
 * Build a customized consult workflow filtered by selected lead short-names.
 * Defaults to the full 3-team layout when teams is undefined or empty.
 *
 * Codex round-4 H-2: accepts an optional workflowName so each /consult
 * invocation registers a uniquely-named workflow.
 *
 * Phase 6: accepts `rounds` (default 1). Each round produces a fresh
 * position-{short}-rN + adversarial-{short}-rN level pair, with the
 * round-N position step depending on the round-(N-1) adversarials so
 * Leads see prior critiques when revising. Synthesis depends on the
 * last round's adversarials and reads files from every round.
 */
export function buildConsultWorkflow(
  teams?: Array<"eng" | "valid" | "invest">,
  workflowName?: string,
  rounds: number = 1,
): Workflow {
  const selected = teams && teams.length > 0 ? teams : ["eng", "valid", "invest"];
  const leadFor = (s: string): string => {
    if (s === "eng") return "engineering-lead";
    if (s === "valid") return "validation-lead";
    return "investigation-lead";
  };
  const leads = selected.map(leadFor);
  const totalRounds = Math.max(1, Math.floor(rounds));
  const allSteps: Step[] = [dispatchStep];
  for (let r = 1; r <= totalRounds; r++) {
    for (const lead of leads) {
      allSteps.push(makePositionStep(lead, r, selected));
    }
    for (const lead of leads) {
      allSteps.push(makeAdversarialStep(lead, r, selected));
    }
  }
  allSteps.push(makeSynthesisStep(totalRounds, selected));
  return {
    ...consult,
    name: workflowName ?? consult.name,
    steps: allSteps,
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
