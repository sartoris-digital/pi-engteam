import { mkdir, appendFile, readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { VerdictPayload } from "../types.js";

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

async function readSessionSlice(runDir: string, agent: string): Promise<string> {
  const path = join(runDir, `session-${agent}.jsonl`);
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const tail = lines.slice(Math.max(0, lines.length - 200));
    return tail.join("\n");
  } catch {
    return "(no session slice available)";
  }
}

function buildVerifierPrompt(opts: {
  cfg: VerifierLoopConfig;
  iter: number;
  reportPath: string;
  sessionSlice: string;
}): string {
  const { cfg, iter, reportPath, sessionSlice } = opts;
  const v = cfg.workerVerdict;
  return `You are the Verifier. Atomize the worker's claims and verify each one via deterministic scripts.

WORKER: ${cfg.workerAgentName}
STEP: ${cfg.workerStep}
ITERATION: ${iter}
RUN_ID: ${cfg.runId}
RUN_DIR: ${cfg.runDir}

WORKER VERDICT:
${JSON.stringify(v, null, 2)}

WORKER ARTIFACTS:
${(v.artifacts ?? []).map((a) => `- ${a}`).join("\n") || "(none)"}

WORKER SESSION SLICE (last 200 lines):
${sessionSlice}

INSTRUCTIONS:
1. Atomize the worker's claims into discrete verifiable items.
2. For each claim, invoke an appropriate script under ~/.pi/engineering-team/verifier-scripts/ via 'uv run --script <script> <args>'.
3. Write your full report to: ${reportPath}
   - Begin every report with a STATUS: line (PASS|FAIL|PARTIAL) and a CONFIDENCE: line (PERFECT|VERIFIED|PARTIAL|FEEDBACK|FAILED).
4. Call VerdictEmit with:
   - step: "verify:${cfg.workerStep}"
   - verdict: PASS | FAIL | PARTIAL
   - issues: one entry per failed claim with file:line and the script output
   - artifacts: ["${reportPath}"]
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

async function appendGap(runDir: string, entry: Record<string, unknown>): Promise<void> {
  const dir = join(runDir, "learning");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "gaps.jsonl"), JSON.stringify(entry) + "\n");
}

export async function runVerifyLoop(cfg: VerifierLoopConfig): Promise<VerifyResult> {
  const verificationDir = join(cfg.runDir, "verification");
  await mkdir(verificationDir, { recursive: true });

  let lastIssues: string[] = [];
  let lastConfidence: VerifyConfidence = "FAILED";

  for (let iter = 1; iter <= cfg.maxVerifyLoops; iter++) {
    const reportPath = join(verificationDir, `${cfg.workerStep}-${iter}.md`);
    const sessionSlice = await readSessionSlice(cfg.runDir, cfg.workerAgentName);
    const prompt = buildVerifierPrompt({ cfg, iter, reportPath, sessionSlice });

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
    let reportText = "";
    try {
      reportText = await readFile(reportPath, "utf8");
    } catch {
      reportText = `STATUS: ${v}\nCONFIDENCE: ${inferConfidence(v, issues)}\n(no report file written)`;
      try { await writeFile(reportPath, reportText); } catch { /* best-effort */ }
    }
    const confidence = parseConfidenceFromReport(reportText) ?? inferConfidence(v, issues);
    lastIssues = issues;
    lastConfidence = confidence;

    if (v === "PASS") {
      return { verdict: "PASS", issues, confidence, report: reportPath };
    }

    if (v === "PARTIAL") {
      for (const claim of issues) {
        const gapEntry = { step: cfg.workerStep, claim, reason: "verifier reported PARTIAL" };
        await appendGap(cfg.runDir, { ...gapEntry, runId: cfg.runId, ts: new Date().toISOString() });
        cfg.onPartialGap?.(gapEntry);
      }
      return { verdict: "PARTIAL", issues, confidence, report: reportPath };
    }

    if (iter < cfg.maxVerifyLoops) {
      const corrective = buildCorrectiveMessage({
        workerStep: cfg.workerStep,
        issues,
        reportPath,
      });
      await cfg.team.deliver(cfg.workerAgentName, {
        id: crypto.randomUUID(),
        from: "verifier",
        to: cfg.workerAgentName,
        summary: `Re-iterate step: ${cfg.workerStep}`,
        message: corrective,
        ts: new Date().toISOString(),
      });
    }
  }

  throw new VerifyExhaustedError(cfg.workerStep, cfg.maxVerifyLoops, lastIssues);
}

export const _testing = { inferConfidence, parseConfidenceFromReport, buildCorrectiveMessage };
