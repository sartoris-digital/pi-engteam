import { mkdir, readFile, writeFile } from "fs/promises";
import { join, basename } from "path";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { VerdictPayload } from "../types.js";

// Replace any character that could escape the verification dir or otherwise
// surprise filesystem semantics. Limit to a conservative env-var-like grammar.
function sanitizeStepName(step: string): string {
  const safe = step.replace(/[^A-Za-z0-9_.-]/g, "_");
  // Reject empty, all-dots, or "." / ".." which `basename` may pass through.
  if (!safe || /^\.+$/.test(safe)) return "step";
  return basename(safe);
}

export type VerifyConfidence = "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED";

export type VerifyResult = {
  verdict: "PASS" | "FAIL" | "PARTIAL";
  issues: string[];
  confidence: VerifyConfidence;
  report: string;
};

export interface VerifierLoopConfig {
  team: TeamRuntime;
  verifierAgentName: string;
  workerAgentName: string;
  workerStep: string;
  workerVerdict: VerdictPayload;
  runId: string;
  runDir: string;
  maxVerifyLoops: number;
  onPartialGap?: (gapEntry: { step: string; claim: string; reason: string }) => void;
}

export class VerifyExhaustedError extends Error {
  constructor(
    public readonly step: string,
    public readonly attempts: number,
    public readonly lastIssues: string[],
  ) {
    super(
      `Verifier exhausted ${attempts} loop(s) on step '${step}' without PASS. Last issues: ${lastIssues.join("; ") || "(none provided)"}`,
    );
    this.name = "VerifyExhaustedError";
  }
}

function inferConfidence(verdict: "PASS" | "FAIL" | "PARTIAL", issues: string[]): VerifyConfidence {
  if (verdict === "PASS") return issues.length === 0 ? "PERFECT" : "VERIFIED";
  if (verdict === "PARTIAL") return "PARTIAL";
  return issues.length > 0 ? "FEEDBACK" : "FAILED";
}

function parseConfidenceFromReport(report: string): VerifyConfidence | undefined {
  const m = report.match(/CONFIDENCE:\s*(PERFECT|VERIFIED|PARTIAL|FEEDBACK|FAILED)/);
  return m ? (m[1] as VerifyConfidence) : undefined;
}

async function readOptionalContext(runDir: string): Promise<string> {
  // Pull plan.md and spec.md if present so the verifier has intent context, not
  // just artifact paths. Codex round-2 P3 NH-2: prevent context starvation on
  // intent-heavy changes.
  const parts: string[] = [];
  for (const name of ["plan.md", "spec.md", "issue-brief.md"]) {
    try {
      const text = await readFile(join(runDir, name), "utf8");
      if (text.trim()) {
        parts.push(`### ${name}\n${text}`);
      }
    } catch { /* file absent — skip */ }
  }
  return parts.join("\n\n---\n\n");
}

function buildVerifierPrompt(opts: {
  cfg: VerifierLoopConfig;
  iter: number;
  workerVerdict: VerdictPayload;
  context: string;
}): string {
  const { cfg, iter, workerVerdict, context } = opts;
  return `You are the Verifier. Atomize the worker's claims and verify each one via deterministic scripts.

WORKER: ${cfg.workerAgentName}
STEP: ${cfg.workerStep}
ITERATION: ${iter}
RUN_ID: ${cfg.runId}
RUN_DIR: ${cfg.runDir}

${context ? `RUN CONTEXT (plan/spec/brief):\n${context}\n` : ""}
WORKER VERDICT:
${JSON.stringify(workerVerdict, null, 2)}

WORKER ARTIFACTS:
${(workerVerdict.artifacts ?? []).map((a) => `- ${a}`).join("\n") || "(none)"}

INSTRUCTIONS:
1. Atomize the worker's claims into discrete verifiable items.
2. For each claim, invoke an appropriate script under ~/.pi/engineering-team/verifier-scripts/ via 'uv run --script <script> <args>'.
3. Call VerdictEmit with:
   - step: "verify:${cfg.workerStep}"
   - verdict: PASS | FAIL | PARTIAL (PASS = every claim verified; FAIL = at least one claim failed; PARTIAL = no failures but some claims unverifiable). Do NOT emit NEEDS_MORE — the verifier is bounded; if you cannot verify, use PARTIAL with a clear gap description.
   - issues: one entry per failed claim with file:line and the script output. The host writes a structured report file from your verdict + issues — you do NOT have Write access.
`;
}

function buildCorrectiveMessage(opts: {
  workerStep: string;
  issues: string[];
  reportPath: string;
}): string {
  return `The verifier ran independent checks against your last ${opts.workerStep} and found gaps that block progression.

ISSUES:
${opts.issues.map((i, n) => `${n + 1}. ${i}`).join("\n")}

REPORT: ${opts.reportPath}

Re-execute step '${opts.workerStep}' addressing each issue. End your turn with a fresh VerdictEmit.`;
}

export async function runVerifyLoop(cfg: VerifierLoopConfig): Promise<VerifyResult> {
  const verificationDir = join(cfg.runDir, "verification");
  await mkdir(verificationDir, { recursive: true });

  let lastIssues: string[] = [];
  // Track the worker verdict that the verifier should re-check. Updated when
  // the worker re-iterates after a corrective message (Codex round-1 P3 H-2).
  let currentWorkerVerdict: VerdictPayload = cfg.workerVerdict;

  const safeStep = sanitizeStepName(cfg.workerStep);
  const context = await readOptionalContext(cfg.runDir);

  for (let iter = 1; iter <= cfg.maxVerifyLoops; iter++) {
    const reportPath = join(verificationDir, `${safeStep}-${iter}.md`);
    const prompt = buildVerifierPrompt({ cfg, iter, workerVerdict: currentWorkerVerdict, context });

    const verdict = await cfg.team.deliver(cfg.verifierAgentName, {
      id: crypto.randomUUID(),
      from: "system",
      to: cfg.verifierAgentName,
      summary: `Verify step: ${cfg.workerStep}`,
      message: prompt,
      ts: new Date().toISOString(),
    });

    if (!verdict) {
      throw new Error(`Verifier did not emit a verdict for step '${cfg.workerStep}' (iter ${iter})`);
    }

    const v = (verdict.verdict as "PASS" | "FAIL" | "PARTIAL") ?? "FAIL";
    const issues = verdict.issues ?? [];
    const confidence = inferConfidence(v, issues);
    lastIssues = issues;

    // Host writes the structured report — verifier has no Write access (M-1).
    const reportText = `STATUS: ${v}\nCONFIDENCE: ${confidence}\n\nWorker step: ${cfg.workerStep}\nIteration: ${iter}\n\nIssues:\n${issues.map((i, n) => `${n + 1}. ${i}`).join("\n") || "(none)"}\n`;
    try { await writeFile(reportPath, reportText); } catch { /* best-effort */ }

    if (v === "PASS") {
      return { verdict: "PASS", issues, confidence, report: reportPath };
    }

    if (v === "PARTIAL") {
      // L-1: ADWEngine's onPartialGap callback is the sole writer to gaps.jsonl.
      // VerifierLoop only emits the gap entries through the callback.
      for (const claim of issues) {
        cfg.onPartialGap?.({ step: cfg.workerStep, claim, reason: "verifier reported PARTIAL" });
      }
      return { verdict: "PARTIAL", issues, confidence, report: reportPath };
    }

    if (iter < cfg.maxVerifyLoops) {
      const corrective = buildCorrectiveMessage({
        workerStep: cfg.workerStep,
        issues,
        reportPath,
      });
      const correctiveVerdict = await cfg.team.deliver(cfg.workerAgentName, {
        id: crypto.randomUUID(),
        from: "verifier",
        to: cfg.workerAgentName,
        summary: `Re-iterate step: ${cfg.workerStep}`,
        message: corrective,
        ts: new Date().toISOString(),
      });
      // H-2: capture the worker's fresh verdict so the next verify pass checks
      // the corrected work, not the stale original verdict.
      if (correctiveVerdict) {
        currentWorkerVerdict = correctiveVerdict;
      }
    }
  }

  throw new VerifyExhaustedError(cfg.workerStep, cfg.maxVerifyLoops, lastIssues);
}

export const _testing = { inferConfidence, parseConfidenceFromReport, buildCorrectiveMessage };
