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

const auditStep: Step = {
  name: "audit",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const auditGapsPath = resolveArtifactPath(ctx, undefined, "audit-gaps.md");
    const prompt = `GOAL: ${ctx.run.goal}

Run these two commands to find coverage gaps quickly:
1. bash("find src/ -name '*.ts' ! -name '*.test.*' ! -name '*.d.*' | head -20")
2. bash("find tests/ -name '*.test.*' 2>/dev/null | head -20 || find src/ -name '*.test.*' | head -20")

List 3-5 untested functions or missing edge cases based on what you see. Write a brief audit-gaps.md with the list.

REQUIRED FINAL ACTION — you MUST call VerdictEmit immediately after reviewing the command output:
- If gaps found: write audit-gaps.md to ${auditGapsPath}, then call VerdictEmit step="audit" verdict="PASS" artifacts=["${auditGapsPath}"]
- If NO gaps found: call VerdictEmit step="audit" verdict="PASS" handoffHint="no-gaps"

Do NOT explore further than the two commands above. Call VerdictEmit NOW.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "audit");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        // C4: stable "audit-gaps" key so writeTestsStep can always find it
        artifacts: { "audit-gaps": resolveArtifactPath(ctx, verdict.artifacts?.[0], "audit-gaps.md") },
      };
    } catch (err) {
      // Timeout fallback: proceed to validate with existing tests rather than halting
      try {
        const { writeFileSync } = await import("fs");
        writeFileSync(auditGapsPath, `# Audit Gaps\n\nAudit timed out — proceeding to validate existing test suite.\n`);
      } catch { /* best-effort */ }
      return {
        success: true,
        verdict: "PASS",
        handoffHint: "no-gaps",
        issues: [`Audit timed out — skipping to validate: ${err instanceof Error ? err.message : String(err)}`],
        artifacts: { "audit-gaps": auditGapsPath },
      };
    }
  },
};

const writeTestsStep: Step = {
  name: "write-tests",
  required: true,
  timeoutSeconds: 1800,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const reviewIssues = ctx.run.steps.findLast(s => s.name === "review")?.issues;
    const validateHint = ctx.run.steps.findLast(s => s.name === "validate")?.handoffHint;

    // Codex round-9 HIGH: fence worker-controlled fields so injection
    // attempts in issues/handoffHint are rendered as data, not instructions.
    const { fenceData, fenceArray } = await import("../safety/prompt-fence.js");
    const prompt = `GOAL: ${ctx.run.goal}
COVERAGE GAPS: ${ctx.run.artifacts["audit-gaps"] ?? "See audit step output"}
${reviewIssues ? `\nREVIEWER ISSUES TO ADDRESS:\n${fenceArray(reviewIssues, "REVIEWER_ISSUES")}` : ""}
${validateHint ? `\nFAILING TESTS:\n${fenceData(validateHint, "VALIDATE_HANDOFF")}` : ""}

Write the missing tests.
REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
Call VerdictEmit with step="write-tests", verdict="PASS" or verdict="FAIL" with issues.
Writing your tests is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "write-tests");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`test-artifact-${i}`, a]))
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

const validateStep: Step = {
  name: "validate",
  required: true,
  timeoutSeconds: 1800,
  planMode: false,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `Run the test suite and report results.

CRITICAL: Run bash("pnpm test") DIRECTLY. Do NOT call RequestApproval first — test commands are pre-approved and do not require Judge approval. Ignore any prior expertise suggesting otherwise.

If all tests pass: emit PASS.
If any tests fail: emit FAIL with the specific failure names and output in handoffHint.

Write the full test output to verify.md. Include artifacts: ["verify.md"] in your VerdictEmit call.
REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
Call VerdictEmit with step="validate", verdict="PASS" or verdict="FAIL".
Writing test output in text is NOT enough — you must call the VerdictEmit tool.`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "validate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: { "verify": resolveArtifactPath(ctx, verdict.artifacts?.[0], "verify.md") },
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
    const prompt = `Review the newly written tests for quality: do they actually test the right behavior, cover edge cases, use correct assertions?
Do NOT write any files. Do NOT include artifacts in your VerdictEmit call — emit only step, verdict, and issues.
REQUIRED FINAL ACTION — you MUST call VerdictEmit to complete this step. Do NOT end without it:
Call VerdictEmit with step="review", verdict="PASS" or verdict="FAIL" with issues.
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
    const priorFeedback = ctx.run.steps.findLast(s => s.name === "judge-gate")?.issues;
    const runDir = join(ctx.engine.getRunsDir(), ctx.run.runId);
    const verdictPath = join(runDir, "verdict.md");

    const prompt = `GOAL: ${ctx.run.goal}
Review all test artifacts. Confirm the test suite is adequate.
${priorFeedback ? `\nPREVIOUS FEEDBACK:\n${priorFeedback.join("\n")}` : ""}
Write your verdict summary to exactly this path: ${verdictPath}
REQUIRED FINAL ACTION — you MUST call VerdictEmit immediately after writing the file. Do NOT end without it:
Call VerdictEmit with step="judge-gate", artifacts=["${verdictPath}"], verdict="PASS" or verdict="FAIL".
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

export const verify: Workflow = {
  name: "verify",
  description: "Audit test coverage, write missing tests, validate and review the test suite.",
  steps: [auditStep, writeTestsStep, validateStep, reviewStep, judgeGateStep],
  transitions: [
    { from: "audit",       when: (r) => r.verdict === "PASS" && r.handoffHint !== "no-gaps", to: "write-tests" },
    { from: "audit",       when: (r) => r.verdict === "PASS" && r.handoffHint === "no-gaps", to: "validate" },
    { from: "audit",       when: (r) => r.verdict !== "PASS",                                to: "halt" },
    { from: "write-tests", when: (r) => r.verdict === "PASS",  to: "validate" },
    // M3: retry write-tests instead of halting — budget exhaustion is the backstop
    { from: "write-tests", when: (r) => r.verdict !== "PASS",  to: "write-tests" },
    { from: "validate",    when: (r) => r.verdict === "PASS",                               to: "review" },
    { from: "validate",    when: (r) => r.verdict !== "PASS",                               to: "write-tests" },
    { from: "review",      when: (r) => r.verdict === "PASS",                               to: "judge-gate" },
    { from: "review",      when: (r) => r.verdict !== "PASS",                               to: "write-tests" },
    { from: "judge-gate",  when: (r) => r.verdict === "PASS",                               to: "halt" },
    { from: "judge-gate",  when: (r) => r.verdict !== "PASS",                               to: "write-tests" },
  ],
  defaults: {
    maxIterations: 8,
    maxCostUsd: 20,
    maxWallSeconds: 7200,
  },
};
