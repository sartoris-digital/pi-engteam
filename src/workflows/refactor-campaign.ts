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

const mapStep: Step = {
  name: "map",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are a codebase cartographer mapping all files affected by a refactor.

GOAL: ${ctx.run.goal}

Please:
1. Identify all files that contain the symbols, patterns, or structures being refactored
2. Note call sites, import paths, type references, and test files
3. Group affected files by category (source, tests, configs, docs)
4. Estimate the scope and risk of each category
5. Produce a map document listing all affected files with reasons

When complete, call VerdictEmit with:
- step: "map"
- verdict: "PASS" (map is complete and scope is understood)
- verdict: "FAIL" with issues listed (if the scope cannot be determined)
- artifacts: ["refactor-map.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "codebase-cartographer", prompt, "map");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { "refactor-map": verdict.artifacts?.[0] ?? "refactor-map.md" },
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
  run: async (ctx: StepContext): Promise<StepResult> => {
    const mapArtifact = ctx.run.artifacts["refactor-map"] ?? "refactor-map.md";
    const judgeFeedback =
      ctx.run.steps.findLast(s => s.name === "judge-gate")?.issues?.join("\n") ?? "";

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

When complete, call VerdictEmit with:
- step: "design"
- verdict: "PASS" (strategy is clear and ordered)
- verdict: "FAIL" with issues listed (if the strategy cannot be determined)
- artifacts: ["refactor-plan.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "architect", prompt, "design");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { "refactor-plan": verdict.artifacts?.[0] ?? "refactor-plan.md" },
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
  run: async (ctx: StepContext): Promise<StepResult> => {
    const verifyHint =
      ctx.run.steps.findLast(s => s.name === "verify")?.handoffHint ?? "";
    const reviewIssues =
      ctx.run.steps.findLast(s => s.name === "review")?.issues?.join("\n") ?? "";

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

When complete, call VerdictEmit with:
- step: "implement"
- verdict: "PASS" (refactor applied, build passes)
- verdict: "FAIL" with issues listed (if blocked)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "implement");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
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

const verifyStep: Step = {
  name: "verify",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are a tester running the full test suite after a refactor.

GOAL: ${ctx.run.goal}

Please:
1. Run the complete test suite (unit, integration, e2e if applicable)
2. Zero regressions are tolerated — every test that passed before must pass now
3. Report any failing tests with full error details
4. Check that the build compiles without errors or warnings

When complete, call VerdictEmit with:
- step: "verify"
- verdict: "PASS" (all tests pass, zero regressions)
- verdict: "FAIL" with issues listed (regressions found)
- handoffHint: summary of failing tests for the implementer`;

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
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are a reviewer checking a completed refactor campaign.

GOAL: ${ctx.run.goal}

Please:
1. Check for missed rename sites (old names still present in source)
2. Look for semantic drift (behaviour changes disguised as renames)
3. Verify import paths are consistent
4. Check documentation and comments are updated
5. Confirm the refactor matches the stated goal

When complete, call VerdictEmit with:
- step: "review"
- verdict: "PASS" (refactor is complete and correct)
- verdict: "FAIL" with a specific list of issues (missed sites, semantic drift, etc.)`;

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
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the judge approving a refactored codebase.

GOAL: ${ctx.run.goal}

Previous steps completed: ${ctx.run.steps.map(s => s.name).join(", ")}

Review:
1. The refactor map covered all affected files
2. The design strategy was sound
3. Tests pass with zero regressions
4. Reviewer found no missed sites or semantic drift
5. The codebase is in a better state than before

When complete, call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" (refactor approved)
- verdict: "FAIL" with issues listed (requires re-design)`;

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
