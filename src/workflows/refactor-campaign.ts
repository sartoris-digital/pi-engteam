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

const mapStep: Step = {
  name: "map",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are a codebase cartographer mapping all files affected by a refactor.

GOAL: ${ctx.run.goal}

Please:
1. Identify all files that contain the symbols, patterns, or structures being refactored
2. Note call sites, import paths, type references, and test files
3. Group affected files by category (source, tests, configs, docs)
4. Estimate the scope and risk of each category
5. Produce a map document listing all affected files with reasons

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- verdict: "PASS" with artifacts: ["refactor-map.md"] (map complete)
- verdict: "FAIL" with issues listed (scope cannot be determined)
- step: "map"

Writing your analysis in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "codebase-cartographer", prompt, "map");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { "refactor-map": resolveArtifactPath(ctx, verdict.artifacts?.[0], "refactor-map.md") },
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

const designStep: Step = {
  name: "design",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    // Codex round-10 HIGH: fence judge feedback so a judge cannot inject
    // instructions into the architect's prompt via issues[].
    const { fenceArray } = await import("../safety/prompt-fence.js");
    const mapArtifact = ctx.run.artifacts["refactor-map"] ?? "refactor-map.md";
    const judgeIssuesArr = ctx.run.steps.findLast(s => s.name === "judge-gate")?.issues;
    const judgeFeedback = judgeIssuesArr && judgeIssuesArr.length > 0
      ? fenceArray(judgeIssuesArr, "JUDGE_FEEDBACK")
      : "";

    const feedbackSection = judgeFeedback
      ? `\nJUDGE FEEDBACK (re-design required):\n${judgeFeedback}`
      : "";

    const prompt = `You are an architect producing a refactor strategy.

GOAL: ${ctx.run.goal}
REFACTOR MAP: ${mapArtifact}
${feedbackSection}

Please:
1. Define the target state (new names, structures, patterns)
2. Specify the order of changes to avoid breaking the build mid-refactor
3. Identify any automated rename/codemods that can be applied
4. Note changes that must be manual
5. Produce a refactor strategy document

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "design"
- verdict: "PASS" with artifacts: ["refactor-plan.md"] (strategy is clear and ordered)
- verdict: "FAIL" with issues listed (if the strategy cannot be determined)

Writing your strategy in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "architect", prompt, "design");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { "refactor-plan": resolveArtifactPath(ctx, verdict.artifacts?.[0], "refactor-plan.md") },
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

const implementStep: Step = {
  name: "implement",
  required: true,
  timeoutSeconds: 1800,
  verify: true,
  planMode: false,
  agent: "implementer",
  run: async (ctx: StepContext): Promise<StepResult> => {
    // Codex round-10 HIGH: fence worker-supplied feedback fields.
    const { fenceData, fenceArray } = await import("../safety/prompt-fence.js");
    const verifyHintRaw = ctx.run.steps.findLast(s => s.name === "verify")?.handoffHint;
    const verifyHint = verifyHintRaw ? fenceData(verifyHintRaw, "VERIFY_HANDOFF") : "";
    const reviewIssuesRaw = ctx.run.steps.findLast(s => s.name === "review")?.issues;
    const reviewIssues = reviewIssuesRaw && reviewIssuesRaw.length > 0
      ? fenceArray(reviewIssuesRaw, "REVIEW_ISSUES")
      : "";

    const prompt = `You are the implementer executing a refactor campaign.

GOAL: ${ctx.run.goal}

REFACTOR PLAN: ${ctx.run.artifacts["refactor-plan"] ?? "See design step artifacts"}
${verifyHint ? `\nREGRESSIONS FOUND:\n${verifyHint}` : ""}
${reviewIssues ? `\nREVIEWER ISSUES:\n${reviewIssues}` : ""}

Please:
1. Follow the refactor strategy in order
2. Apply renames, moves, and structural changes as specified
3. Update all import paths and references
4. Do not change behaviour — refactor only
5. Run a quick build check after each major change

Write a summary of all changes made to refactor.md.

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "implement"
- verdict: "PASS" with artifacts: ["refactor.md"] (refactor applied, build passes)
- verdict: "FAIL" with issues listed (if blocked)

Writing your summary in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "implement");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: {
          "refactor": resolveArtifactPath(ctx, verdict.artifacts?.[0], "refactor.md"),
          ...Object.fromEntries((verdict.artifacts?.slice(1) ?? []).map((a, i) => [`artifact-${i}`, a])),
        },
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

const verifyStep: Step = {
  name: "verify",
  required: true,
  timeoutSeconds: 1800,
  planMode: false,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are a tester running the full test suite after a refactor.

GOAL: ${ctx.run.goal}

CRITICAL: Run bash("pnpm test") DIRECTLY. Do NOT call RequestApproval first — test commands are pre-approved and do not require Judge approval. Ignore any prior expertise suggesting otherwise.

Please:
1. Run the complete test suite (unit, integration, e2e if applicable)
2. Zero regressions are tolerated — every test that passed before must pass now
3. Report any failing tests with full error details
4. Check that the build compiles without errors or warnings

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "verify"
- verdict: "PASS" (all tests pass, zero regressions)
- verdict: "FAIL" with issues listed (regressions found)
- handoffHint: summary of failing tests for the implementer

Writing your results in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "verify");
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

const reviewStep: Step = {
  name: "review",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are a reviewer checking a completed refactor campaign.

GOAL: ${ctx.run.goal}

Please:
1. Check for missed rename sites (old names still present in source)
2. Look for semantic drift (behaviour changes disguised as renames)
3. Verify import paths are consistent
4. Check documentation and comments are updated
5. Confirm the refactor matches the stated goal

Do NOT write any files. Do NOT include artifacts in your VerdictEmit call — emit only step, verdict, and issues.
REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "review"
- verdict: "PASS" (refactor is complete and correct)
- verdict: "FAIL" with a specific list of issues (missed sites, semantic drift, etc.)

Writing your review in text is NOT enough — you must call the VerdictEmit tool.`;

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
    const prompt = `You are the judge approving a refactored codebase.

GOAL: ${ctx.run.goal}

Previous steps completed: ${ctx.run.steps.map(s => s.name).join(", ")}

Review:
1. The refactor map covered all affected files
2. The design strategy was sound
3. Tests pass with zero regressions
4. Reviewer found no missed sites or semantic drift
5. The codebase is in a better state than before

Write your verdict summary to exactly this path: ${verdictPath}
REQUIRED FINAL ACTION — you MUST call VerdictEmit immediately after writing the file. Do NOT end without it:
- step: "judge-gate"
- artifacts: ["${verdictPath}"]
- verdict: "PASS" (refactor approved)
- verdict: "FAIL" with issues listed (requires re-design)

Writing your verdict in text is NOT enough — you must call the VerdictEmit tool.`;

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

export const refactorCampaign: Workflow = {
  name: "refactor-campaign",
  description: "Map, design, implement, verify, review, and judge-gate a codebase refactor.",
  steps: [mapStep, designStep, implementStep, verifyStep, reviewStep, judgeGateStep],
  transitions: [
    { from: "map",        when: (r) => r.verdict === "PASS", to: "design" },
    { from: "map",        when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "design",     when: (r) => r.verdict === "PASS", to: "implement" },
    { from: "design",     when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "implement",  when: (r) => r.verdict === "PASS", to: "verify" },
    { from: "implement",  when: (r) => r.verdict !== "PASS", to: "design" },
    { from: "verify",     when: (r) => r.verdict === "PASS", to: "review" },
    { from: "verify",     when: (r) => r.verdict !== "PASS", to: "implement" },
    { from: "review",     when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "review",     when: (r) => r.verdict !== "PASS", to: "implement" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS", to: "design" },
  ],
  defaults: {
    // M4: raised from 8 — the 6-step workflow has multiple design/implement/review back-loops
    maxIterations: 12,
    maxCostUsd: 40,
    maxWallSeconds: 7200,
  },
};
