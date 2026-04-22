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

const discoverStep: Step = {
  name: "discover",
  required: true,
  // L3: allow the user to write answers.md via the Pi session while paused in the answering phase
  planMode: false,
  pauseAfter: "answering",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are gathering requirements for this feature goal:

GOAL: ${ctx.run.goal}

Write a questions.md file with 3-5 focused discovery questions in these exact categories: SCOPE, CONSTRAINTS, SUCCESS, CONTEXT.

Use this exact format:
## SCOPE
1. [question]

## CONSTRAINTS
2. [question]

## SUCCESS
3. [question]

## CONTEXT
4. [question]

Questions should be one sentence each. Save the file to questions.md in the current run directory.
Call VerdictEmit with step: "discover", verdict: "PASS", artifacts: ["questions.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "discoverer", prompt, "discover");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { questions: "questions.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const designStep: Step = {
  name: "design",
  required: true,
  pauseAfter: "approving",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are writing a feature specification.

GOAL: ${ctx.run.goal}

Read answers.md for the user's discovery answers. Write spec.md with these exact sections:
# Spec: [Feature Name]

## Problem
[What is broken or missing]

## Approach
[Chosen solution and why]

## Acceptance Criteria
- [Observable, testable outcome]

## Key Interfaces
[TypeScript types or prose describing public API shapes]

## Out of Scope
- [Explicit exclusions]

## Open Questions
- [Unresolved decisions to be made during implementation]

Be specific. No filler.
Call VerdictEmit with step: "design", verdict: "PASS", artifacts: ["spec.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "architect", prompt, "design");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { spec: "spec.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const planStep: Step = {
  name: "plan",
  required: true,
  pauseAfter: "approving",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const specArtifact = ctx.run.artifacts["spec"] ?? "spec.md";
    const prompt = `You are writing an implementation plan.

GOAL: ${ctx.run.goal}
SPEC: ${specArtifact}

Read the spec file. Write plan.md with:
1. A file structure table: file path and its single responsibility
2. Checkbox tasks grouped by phase, each tagged [fast], [standard], or [reasoning]
   - fast: simple edits, field additions
   - standard: new modules, API calls, moderate logic
   - reasoning: architecture decisions, security-sensitive code

Format tasks as:
- [ ] [standard] Description — file: path/to/file.ts

Call VerdictEmit with step: "plan", verdict: "PASS", artifacts: ["plan.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "planner", prompt, "plan");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { plan: verdict.artifacts?.[0] ?? "plan.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const buildStep: Step = {
  name: "build",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["plan"] ?? "No plan artifact found";
    const prompt = `You are the implementer. Execute the plan:

PLAN LOCATION: ${planArtifact}

1. Read the plan file
2. Implement each task in order
3. Write tests alongside code (TDD)
4. For destructive operations (git push, npm install, file delete), call RequestApproval first

Call VerdictEmit with step: "build", verdict: "PASS" when implementation is complete and tests pass, or "FAIL" with specific issues listed.`;

    try {
      const verdict = await waitForVerdict(ctx, "implementer", prompt, "build");
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
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const reviewStep: Step = {
  name: "review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const specArtifact = ctx.run.artifacts["spec"] ?? "spec.md";
    const prompt = `You are the reviewer. Review the implementation for:

GOAL: ${ctx.run.goal}
SPEC: ${specArtifact}

Check all changed/created files for logical errors, missing tests, security issues, and spec compliance.
Read the spec file and verify the implementation matches it.
Call VerdictEmit with step: "review", verdict: "PASS" or "FAIL" with specific issues.
Set handoffHint: "security" | "perf" | "re-plan" if the failure category warrants specialist escalation.`;

    try {
      const verdict = await waitForVerdict(ctx, "reviewer", prompt, "review");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const specPlanBuildReview: Workflow = {
  name: "spec-plan-build-review",
  description: "Discover requirements, write spec, plan, build, and review.",
  steps: [discoverStep, designStep, planStep, buildStep, reviewStep],
  transitions: [
    { from: "discover", when: (r) => r.verdict === "PASS", to: "design" },
    { from: "discover", when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "design",   when: (r) => r.verdict === "PASS", to: "plan" },
    { from: "design",   when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "plan",     when: (r) => r.verdict === "PASS", to: "build" },
    { from: "plan",     when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "build",    when: (r) => r.verdict === "PASS", to: "review" },
    // H2: build failures should re-plan instead of discarding discover/spec/plan work
    { from: "build",    when: (r) => r.verdict !== "PASS", to: "plan" },
    { from: "review",   when: (_r) => true,                to: "halt" },
  ],
  defaults: {
    maxIterations: 12,
    maxCostUsd: 30,
    maxWallSeconds: 7200,
  },
};
