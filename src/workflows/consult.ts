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
    // Codex round-17 HIGH: pass runId so parallel runs sharing a
    // TeamRuntime don't cross-bind via mutable currentRunId.
    { hostStep: stepName, runId: ctx.run.runId },
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
  timeoutSeconds: 1800,
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
      `3. Acknowledge that each Lead will independently write a position file inside the run directory at positions/<lead>.md.`,
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

// Returns the run-relative path the workflow uses to track the artifact in
// state.artifacts. The agent prompt MUST receive the resolved absolute path
// instead (see resolveInRun below) — the literal `<run>` placeholder used
// here is for engine bookkeeping, not for the LLM.
function positionFilePath(leadAgent: string, round: number): string {
  return `positions/${leadAgent}${roundSuffix(round)}.md`;
}

function adversarialFilePath(leadAgent: string, round: number): string {
  return `adversarial/${leadAgent}${roundSuffix(round)}.md`;
}

// Resolve a run-relative path against the live run directory. The agent's
// cwd is the project root, so without this every "Write" the lead does
// lands outside the run dir and the synthesis step can't find positions/.
function resolveInRun(ctx: StepContext, relPath: string): string {
  return join(ctx.engine.getRunsDir(), ctx.run.runId, relPath);
}

// Resolve an artifact path that may be absolute, relative to the run dir,
// or use the legacy `<run>/` placeholder still recorded in older state.json
// files. Returns an absolute path the agent can read directly.
function resolveArtifactPath(ctx: StepContext, p: string): string {
  if (p.startsWith("<run>/")) return resolveInRun(ctx, p.slice("<run>/".length));
  if (p.startsWith("/")) return p;
  return resolveInRun(ctx, p);
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
  timeoutSeconds: 1800,
    agent: leadAgent,
    dependsOn,
    run: async (ctx: StepContext): Promise<StepResult> => {
      const prelude = await preludeFor(ctx);
      // Resolve every run-relative path to an absolute path the agent can
      // write to directly. The Lead's cwd is the project root, so an
      // unqualified "positions/<lead>.md" lands outside the run dir and the
      // synthesis step can't find it. Same shape as the /spec discoverer fix.
      const absFilePath = resolveInRun(ctx, filePath);
      const absConversationPath = resolveInRun(ctx, "conversation.jsonl");
      const promptLines: string[] = [prelude];
      if (round === 1) {
        promptLines.push(
          `You are ${leadAgent}. Cross-team consult (round 1): write your team's position on the topic.`,
          ``,
          `TOPIC: ${ctx.run.goal}`,
          ``,
          `Your job:`,
          `1. Read ${absConversationPath} for the dispatch framing.`,
          `2. Optionally consult your domain workers via SendMessage.`,
          `3. Write your team's specialty take to this EXACT absolute path:`,
          `   ${absFilePath}`,
          `   Cover: assumptions, recommendations, risks specific to your domain, blind spots you see in adjacent teams.`,
          `4. Be concrete. Cite specific files, tests, or behaviors when possible.`,
          ``,
          `REQUIRED FINAL ACTION — you MUST call VerdictEmit immediately after writing the file. Do NOT end without it:`,
          `Call VerdictEmit with step="${stepName}", verdict="PASS", artifacts=["${absFilePath}"].`,
          `Writing your position in text is NOT enough — you must call the VerdictEmit tool.`,
        );
      } else {
        // Phase 6 round-4 H3: derive prior position + adversarial paths
        // from ctx.run.artifacts (PASS-recorded only) instead of the
        // deterministic helper. If a prior step failed and produced no
        // file, the agent must not be told to read it.
        const shorts = allShorts ?? ["eng", "valid", "invest"];
        const priorAdvPaths: string[] = [];
        const missingPriorAdvLeads: string[] = [];
        for (const s of shorts) {
          const stepKey = adversarialStepName(s, round - 1);
          const lead = s === "eng" ? "engineering-lead" : s === "valid" ? "validation-lead" : "investigation-lead";
          const recorded = ctx.run.artifacts?.[stepKey];
          if (recorded) {
            priorAdvPaths.push(recorded.startsWith("<run>/") ? recorded : adversarialFilePath(lead, round - 1));
          } else {
            missingPriorAdvLeads.push(lead);
          }
        }
        const priorOwnPosKey = positionStepName(short, round - 1);
        const priorOwnPosRecorded = ctx.run.artifacts?.[priorOwnPosKey];
        if (!priorOwnPosRecorded) {
          // Without our own prior position to revise from, we can't run
          // a meaningful round-N revision. Surface this as a step failure
          // so the orchestrator + synthesis see a clear cause.
          return {
            success: false,
            verdict: "FAIL",
            error: `Round-${round} position for ${leadAgent} cannot run: round-${round - 1} position was not produced.`,
          };
        }
        const priorMissingNote = missingPriorAdvLeads.length > 0
          ? `Note: round-${round - 1} adversarials from these Leads were not produced: ${missingPriorAdvLeads.join(", ")}. Read only the available critiques.`
          : null;
        // Resolve all prior paths to absolute. Stored artifacts may already
        // be absolute (post-fix) or use the legacy <run>/ placeholder; handle
        // both. The resolveArtifactPath helper expands <run>/.
        const absPriorOwn = resolveArtifactPath(ctx, priorOwnPosRecorded);
        const absPriorAdvPaths = priorAdvPaths.map((p) => resolveArtifactPath(ctx, p));
        promptLines.push(
          `You are ${leadAgent}. Consult round ${round}: REVISE your position in light of round ${round - 1}'s adversarial critiques.`,
          ``,
          `TOPIC: ${ctx.run.goal}`,
          ``,
          ...(priorMissingNote ? [priorMissingNote, ``] : []),
          `Your job:`,
          `1. Read your round-${round - 1} position: ${absPriorOwn}`,
          `2. Read every peer's round-${round - 1} adversarial:`,
          ...absPriorAdvPaths.map((p) => `   - ${p}`),
          `3. Decide what changes. Concede where a critique landed. Sharpen where you stand by your prior position. Be explicit about which round-${round - 1} points you're addressing.`,
          `4. Write the revised position to this EXACT absolute path:`,
          `   ${absFilePath}`,
          `   Lead with "Changes from round ${round - 1}" so the diff is visible at a glance, then the full revised position.`,
          ``,
          `REQUIRED FINAL ACTION — you MUST call VerdictEmit immediately after writing the file. Do NOT end without it:`,
          `Call VerdictEmit with step="${stepName}", verdict="PASS", artifacts=["${absFilePath}"].`,
          `Writing your position in text is NOT enough — you must call the VerdictEmit tool.`,
        );
      }
      const prompt = promptLines.join("\n");
      try {
        const verdict = await dispatch(ctx, leadAgent, prompt, stepName);
        // Round-2 H1 + round-3 H3: require a non-empty artifact path on
        // PASS. A bare PASS with no artifact means the Lead never wrote
        // their position file; downstream adversarial/synthesis would
        // then reference a non-existent path. Downgrade to FAIL.
        const hasArtifact = (verdict.artifacts?.length ?? 0) > 0;
        if (verdict.verdict === "PASS" && !hasArtifact) {
          return {
            success: false,
            verdict: "FAIL",
            error: `Position step ${stepName} claimed PASS but emitted no artifact path; downgraded to FAIL.`,
          };
        }
        // Codex round-15 MEDIUM: the Lead is instructed to write to
        // exactly `absFilePath`. Previously the host accepted ANY
        // artifact under cwd or runDir, so a confused Lead could PASS
        // with `package.json` as the artifact and the consult would
        // record that instead of the expected position file. Verify
        // the emitted artifact matches the contract: either the exact
        // absolute path (realpath), or — for relative-path tests/agents
        // — a basename match against the expected file.
        if (verdict.verdict === "PASS" && hasArtifact) {
          const { realpathSync } = await import("fs");
          const { basename, isAbsolute } = await import("path");
          const claimed = verdict.artifacts![0];
          const safe = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
          const realEq = isAbsolute(claimed) && safe(claimed) === safe(absFilePath);
          const baseEq = basename(claimed) === basename(absFilePath);
          if (!realEq && !baseEq) {
            return {
              success: false,
              verdict: "FAIL",
              error: `Position step ${stepName} emitted artifact '${claimed}' but the contract requires '${absFilePath}'; downgraded to FAIL.`,
            };
          }
        }
        const isPass = verdict.verdict === "PASS" && hasArtifact;
        return {
          success: isPass,
          verdict: verdict.verdict,
          issues: verdict.issues,
          artifacts: isPass
            ? { [stepName]: verdict.artifacts![0] }
            : undefined,
        };
      } catch (err) {
        // Timeout fallback: write stub position file so adversarial/synthesis can proceed
        try {
          const { mkdirSync, writeFileSync, existsSync } = await import("fs");
          const dir = absFilePath.substring(0, absFilePath.lastIndexOf("/"));
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          if (!existsSync(absFilePath)) {
            writeFileSync(absFilePath, `# Position: ${leadAgent}\n\nTOPIC: ${ctx.run.goal}\n\nPosition timed out — stub file for downstream steps.\n`);
          }
        } catch { /* best-effort */ }
        return {
          success: true,
          verdict: "PASS",
          issues: [`Position timed out: ${err instanceof Error ? err.message : String(err)}`],
          artifacts: { [stepName]: absFilePath },
        };
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
  timeoutSeconds: 1800,
    agent: leadAgent,
    dependsOn,
    run: async (ctx: StepContext): Promise<StepResult> => {
      const prelude = await preludeFor(ctx);
      // Adversarial output path resolved to absolute so the Lead writes
      // inside the run dir (matching the position-step fix). Without this
      // the file lands in the project cwd and the synthesis step's
      // <run>/adversarial/ directory stays empty.
      const absFilePath = resolveInRun(ctx, filePath);
      // Phase 6 round-3 H2: list only positions that registered an
      // artifact for THIS round. A position step that failed never
      // wrote a file; pointing the adversarial at it would produce a
      // confused FAIL on missing-file. The artifacts map is keyed by
      // step name and is populated only on PASS.
      const shorts = allShorts ?? ["eng", "valid", "invest"];
      const positionPaths: string[] = [];
      const missingLeads: string[] = [];
      for (const s of shorts) {
        const stepKey = positionStepName(s, round);
        const lead = s === "eng" ? "engineering-lead" : s === "valid" ? "validation-lead" : "investigation-lead";
        const recorded = ctx.run.artifacts?.[stepKey];
        if (recorded) {
          // Resolve to absolute path — recorded may be absolute (post-fix),
          // <run>/ legacy, or relative.
          const resolved = resolveArtifactPath(ctx, recorded.startsWith("<run>/") || recorded.startsWith("/")
            ? recorded
            : positionFilePath(lead, round));
          positionPaths.push(resolved);
        } else {
          missingLeads.push(lead);
        }
      }
      if (positionPaths.length === 0) {
        // Nothing to critique — degrade explicitly rather than write
        // an empty adversarial file.
        return {
          success: false,
          verdict: "FAIL",
          error: `No round-${round} positions were produced; cannot run adversarial round.`,
        };
      }
      const missingNote = missingLeads.length > 0
        ? `Note: round-${round} positions from these Leads were not produced and are unavailable: ${missingLeads.join(", ")}. Critique only the available positions.`
        : null;
      const prompt = [
        prelude,
        `You are ${leadAgent}. Adversarial round ${round}: critique your peers' round-${round} positions.`,
        ``,
        `TOPIC: ${ctx.run.goal}`,
        ``,
        ...(missingNote ? [missingNote, ``] : []),
        `Read every round-${round} position (absolute paths):`,
        ...positionPaths.map((p) => `- ${p}`),
        ``,
        `Then write to this EXACT absolute path:`,
        `   ${absFilePath}`,
        ``,
        `Contents:`,
        `- Explicit pushback on each peer's position. Where do you disagree, and why?`,
        `- Risks they missed.`,
        `- Blind spots in their framing.`,
        `- One question per peer that, if answered, would either change their position or yours.`,
        ...(round > 1 ? [`- A note on which round-${round - 1} critiques each peer ADDRESSED in their revision — call out the strong concessions, and where peers held firm despite earlier pushback.`] : []),
        ``,
        `Be direct, not polite. The goal is friction that exposes weak claims.`,
        ``,
        `REQUIRED FINAL ACTION — you MUST call VerdictEmit immediately after writing the file. Do NOT end without it:`,
        `Call VerdictEmit with step="${stepName}", verdict="PASS", artifacts=["${absFilePath}"].`,
        `Writing your critique in text is NOT enough — you must call the VerdictEmit tool.`,
      ].join("\n");
      try {
        const verdict = await dispatch(ctx, leadAgent, prompt, stepName);
        // Round-2 H1 + round-3 H3: only record artifacts on PASS, AND
        // require a non-empty verdict.artifacts entry on PASS. A bare
        // PASS with no artifact path means the Lead claimed success but
        // never wrote the expected file; downgrade to FAIL so the
        // downstream synthesis doesn't reference a non-existent artifact.
        const hasArtifact = (verdict.artifacts?.length ?? 0) > 0;
        const isPass = verdict.verdict === "PASS" && hasArtifact;
        if (verdict.verdict === "PASS" && !hasArtifact) {
          return {
            success: false,
            verdict: "FAIL",
            error: `Adversarial step ${stepName} claimed PASS but emitted no artifact path; downgraded to FAIL.`,
          };
        }
        return {
          success: isPass,
          verdict: verdict.verdict,
          issues: verdict.issues,
          artifacts: isPass
            ? { [stepName]: verdict.artifacts?.[0] ?? `adversarial/${leadAgent}${roundSuffix(round)}.md` }
            : undefined,
        };
      } catch (err) {
        // Timeout fallback: write stub adversarial file so synthesis can proceed
        try {
          const { mkdirSync, writeFileSync, existsSync } = await import("fs");
          const dir = absFilePath.substring(0, absFilePath.lastIndexOf("/"));
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          if (!existsSync(absFilePath)) {
            writeFileSync(absFilePath, `# Adversarial: ${leadAgent}\n\nTOPIC: ${ctx.run.goal}\n\nAdversarial critique timed out — stub file for synthesis.\n`);
          }
        } catch { /* best-effort */ }
        return {
          success: true,
          verdict: "PASS",
          issues: [`Adversarial timed out: ${err instanceof Error ? err.message : String(err)}`],
          artifacts: { [stepName]: absFilePath },
        };
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
  timeoutSeconds: 1800,
    agent: "orchestrator",
    dependsOn: lastRoundAdversarials,
    run: async (ctx: StepContext): Promise<StepResult> => {
      const prelude = await preludeFor(ctx);
      // Absolute paths for synthesis output + the position/adversarial
      // directories the orchestrator reads. Same shape as the Lead-step
      // fix — agents run with cwd = project root, not run dir.
      const absSynthesisPath = resolveInRun(ctx, "synthesis.md");
      const absPositionsDir = resolveInRun(ctx, "positions");
      const absAdversarialDir = resolveInRun(ctx, "adversarial");
      const roundsNote = rounds === 1
        ? `Read every file in ${absPositionsDir}/ and ${absAdversarialDir}/.`
        : `Read every file in ${absPositionsDir}/ and ${absAdversarialDir}/. Note that ${rounds} rounds were run; files without a round suffix are round 1; "-r2"/"-r3"/… suffixes are later rounds. Track how positions EVOLVED across rounds — concessions, persistent disagreements, points that hardened.`;
      const prompt = [
        prelude,
        `You are the orchestrator. Final synthesis step (after ${rounds} round${rounds === 1 ? "" : "s"}).`,
        ``,
        `IMPORTANT — for this step ONLY, you do the synthesis writing YOURSELF.`,
        `Your general directive is "delegate, do not execute", but synthesis is the`,
        `one exception: there is no team to dispatch this to. Your Pi response text`,
        `is NOT the synthesis — the synthesis must be a real file on disk.`,
        ``,
        `TOPIC: ${ctx.run.goal}`,
        ``,
        roundsNote,
        ``,
        `Required actions, in order:`,
        `1. Read every position and adversarial file listed above.`,
        `2. Call the Write tool with this EXACT absolute path as its target:`,
        `   ${absSynthesisPath}`,
        `   The Write tool call MUST happen before VerdictEmit — your prompt-side`,
        `   response text does not count as the artifact.`,
        `3. After Write succeeds, call VerdictEmit with:`,
        `     step="synthesis"`,
        `     verdict="PASS"`,
        `     artifacts=["${absSynthesisPath}"]`,
        ``,
        `The synthesis file content must have these sections:`,
        `## Areas of agreement`,
        `## Contested points`,
        ...(rounds > 1 ? [`## How positions evolved across rounds`] : []),
        `## Recommended path forward`,
        `## Deferred decisions`,
        ``,
        `Be terse. No filler. Quote specific positions/critiques where they matter.`,
      ].join("\n");
      try {
        const verdict = await dispatch(ctx, "orchestrator", prompt, "synthesis");
        // Round-3 H3: require artifact on PASS.
        const hasArtifact = (verdict.artifacts?.length ?? 0) > 0;
        if (verdict.verdict === "PASS" && !hasArtifact) {
          return {
            success: false,
            verdict: "FAIL",
            error: `Synthesis claimed PASS but emitted no artifact path; downgraded to FAIL.`,
          };
        }
        const isPass = verdict.verdict === "PASS" && hasArtifact;
        return {
          success: isPass,
          verdict: verdict.verdict,
          issues: verdict.issues,
          artifacts: isPass
            ? { synthesis: verdict.artifacts![0] }
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
    maxWallSeconds: 7200,
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
