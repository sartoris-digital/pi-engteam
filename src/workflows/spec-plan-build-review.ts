import { join } from "path";
import { writeFileSync, existsSync } from "fs";
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";
import { resolveArtifactPath } from "./helpers.js";

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
  }, { runId: ctx.run.runId });
  if (!verdict) {
    throw new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within timeout`);
  }
  return verdict;
}

const discoverStep: Step = {
  name: "discover",
  required: true,
  timeoutSeconds: 1800,
  // L3: allow the user to write answers.md via the Pi session while paused in the answering phase
  planMode: false,
  pauseAfter: "answering",
  run: async (ctx: StepContext): Promise<StepResult> => {
    // The discoverer's cwd is the project root (not the run dir), so an
    // unqualified "questions.md" gets written to the project, not where the
    // pre-design check reads it. Give the agent the absolute path and tell
    // it to emit that absolute path as the artifact.
    const questionsAbsPath = join(ctx.engine.getRunsDir(), ctx.run.runId, "questions.md");
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

Questions should be one sentence each.

IMPORTANT: Write the file to this EXACT absolute path:
${questionsAbsPath}

Do not use a relative path — use the absolute path above so the file lands in the run directory the workflow expects.

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "discover", verdict: "PASS", artifacts: ["${questionsAbsPath}"]

Writing your questions in text is NOT enough — you must call the VerdictEmit tool.`;

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
  timeoutSeconds: 1800,
  pauseAfter: "approving",
  run: async (ctx: StepContext): Promise<StepResult> => {
    // Give the architect the absolute run-dir paths (mirrors the discover-step
    // fix in 50fabd6). Without explicit paths the agent writes spec.md to the
    // project cwd, which works only because the artifact verifier accepts cwd
    // — the post-design /spec notify ("spec written → <runDir>/spec.md") then
    // points the user at the wrong file.
    const answersAbsPath = join(ctx.engine.getRunsDir(), ctx.run.runId, "answers.md");
    const specAbsPath = join(ctx.engine.getRunsDir(), ctx.run.runId, "spec.md");
    const prompt = `You are writing a feature specification.

GOAL: ${ctx.run.goal}

Read ${answersAbsPath} for the user's discovery answers.

Write the spec to this EXACT absolute path:
${specAbsPath}

The file must have these exact sections:
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

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "design", verdict: "PASS", artifacts: ["${specAbsPath}"]

Writing the spec in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForVerdict(ctx, "architect", prompt, "design");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { spec: specAbsPath },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const planStep: Step = {
  name: "plan",
  required: true,
  timeoutSeconds: 1800,
  pauseAfter: "approving",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const specArtifact = ctx.run.artifacts["spec"] ?? join(ctx.engine.getRunsDir(), ctx.run.runId, "spec.md");
    const planAbsPath = join(ctx.engine.getRunsDir(), ctx.run.runId, "plan.md");
    const prompt = `You are writing an implementation plan.

GOAL: ${ctx.run.goal}
SPEC: ${specArtifact}

Read the spec at the path above.

Write the plan to this EXACT absolute path:
${planAbsPath}

The plan must contain:
1. A file structure table: file path and its single responsibility
2. Checkbox tasks grouped by phase, each tagged [fast], [standard], or [reasoning]
   - fast: simple edits, field additions
   - standard: new modules, API calls, moderate logic
   - reasoning: architecture decisions, security-sensitive code

Format tasks as:
- [ ] [standard] Description — file: path/to/file.ts

REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "plan", verdict: "PASS", artifacts: ["${planAbsPath}"]

Writing the plan in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForVerdict(ctx, "planner", prompt, "plan");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { plan: verdict.artifacts?.[0] ?? planAbsPath },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const buildStep: Step = {
  name: "build",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["plan"] ?? "No plan artifact found";
    const { fenceArray } = await import("../safety/prompt-fence.js");
    const reviewIssuesRaw = ctx.run.steps.findLast(s => s.name === "review")?.issues;
    const reviewIssues = reviewIssuesRaw && reviewIssuesRaw.length > 0
      ? fenceArray(reviewIssuesRaw, "REVIEW_ISSUES")
      : "";
    const prompt = `You are the implementer. Execute the plan:

PLAN LOCATION: ${planArtifact}
${reviewIssues ? `\nREVIEWER ISSUES TO FIX:\n${reviewIssues}\n` : ""}
1. Read the plan file
2. Implement each task in order
3. Write tests in tests/unit/ (this repo's convention — do NOT create co-located *.test.ts files in src/)
4. For destructive operations (git push, npm install, file delete), call RequestApproval first
${reviewIssues ? "5. Address ALL reviewer issues listed above — especially any co-located test files that must be deleted\n" : ""}
REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "build", verdict: "PASS" (implementation complete, tests passing)
- step: "build", verdict: "FAIL" with specific issues listed (if blocked or tests failing)

Writing your summary in text is NOT enough — you must call the VerdictEmit tool.`;

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
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const specArtifact = ctx.run.artifacts["spec"] ?? "spec.md";
    const reviewPath = resolveArtifactPath(ctx, undefined, "review.md");
    const prompt = `You are the reviewer. Review the implementation for:

GOAL: ${ctx.run.goal}
SPEC: ${specArtifact}

Check all changed/created files for logical errors, missing tests, security issues, and spec compliance.
Read the spec file and verify the implementation matches it.
Write your detailed review findings to this EXACT path: ${reviewPath}
REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
- step: "review"
- verdict: "PASS" or "FAIL" with specific issues
- artifacts: ["${reviewPath}"]
- handoffHint: "security" | "perf" | "re-plan" if the failure category warrants specialist escalation

Writing your review in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForVerdict(ctx, "reviewer", prompt, "review");
      const runDir = join(ctx.engine.getRunsDir(), ctx.run.runId);
      const reviewMdPath = join(runDir, "review.md");
      // Fallback: write review.md from verdict data if agent didn't produce it
      if (!existsSync(reviewMdPath)) {
        const lines = [`# Code Review: ${verdict.verdict}`];
        if (verdict.issues?.length) lines.push(`\n## Issues\n${verdict.issues.map(i => `- ${i}`).join("\n")}`);
        if (verdict.handoffHint) lines.push(`\n## Escalation: ${verdict.handoffHint}`);
        writeFileSync(reviewMdPath, lines.join("\n") + "\n");
      }
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: { "review": reviewMdPath },
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
    { from: "review",   when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "review",   when: (r) => r.verdict !== "PASS", to: "build" },
  ],
  defaults: {
    maxIterations: 12,
    maxCostUsd: 30,
    maxWallSeconds: 7200,
  },
};
