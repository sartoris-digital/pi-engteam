// src/learner/LearnerOrchestrator.ts
// Phase 3.5 — coordinates the 8-step Learner workflow.
//
// The orchestrator dispatches creative reasoning (gather, classify, design) to
// the learner agent subprocess, then performs deterministic file mutations,
// fixture validation, Judge round-trip, atomic promotion, archival, and
// reporting in TypeScript. Promotion is gated on (1) staging-only writes by
// the learner (Layer D), (2) HMAC-signed Judge approval, (3) all-fixtures-pass
// validation. Atomic mv assumption: fs.promises.rename is atomic on POSIX
// when source and destination are on the same filesystem. .staging/ and the
// active scripts dir share the same parent, so this is safe.
import { spawn } from "child_process";
import { mkdir, readdir, readFile, rename, writeFile, appendFile, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join, basename } from "path";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { TeamMessage, VerdictPayload } from "../types.js";

export type GapEntry = {
  runId: string;
  step: string;
  claim: string;
  reason: string;
  ts: string;
};

export type GapCategory =
  | "existing-script-extension"
  | "new-domain-script"
  | "persona-edit"
  | "unaddressable-escalation";

export type ProposedChange = {
  gap: GapEntry;
  category: GapCategory;
  scriptName: string;          // e.g., "verify_typescript.py"
  approach: string;             // free-form description for the Judge
  fixturePath: string;          // path under .fixtures/<name>
  regressionCommand: string;    // shell command (uv run --script ...) demonstrating the new check
};

export type LearnerConfig = {
  team: TeamRuntime;
  learnerAgentName: string;
  judgeAgentName: string;
  scriptsDir: string;
  stagingDir: string;
  versionsDir: string;
  fixturesDir: string;
  changelogPath: string;
  /** Explicit gap files; orchestrator reads each and aggregates. */
  gapsPaths: string[];
  /**
   * Run identity for the judge subprocess. Optional only for unit tests
   * that mock the judge response — production callers MUST pass both, so
   * the orchestrator can verify that GrantApproval actually minted a
   * token in `<runsDir>/<runId>/approvals/` before promoting a verifier
   * script. Codex round-6 HIGH closed the bypass where judge PASS alone
   * authorized promotion. When BOTH are omitted, token verification is
   * skipped (legacy test behaviour); production must always supply them.
   */
  runsDir?: string;
  runId?: string;
  /** Where to write the report. The first gap's runDir is used by default. */
  reportRunDir?: string;
  onPromote?: (script: string, version: string) => void;
};

export type LearnerResult = {
  gapsProcessed: number;
  scriptsProposed: number;
  scriptsApproved: number;
  scriptsPromoted: number;
  escalations: string[];
  reportPath: string;
};

// ── Step 1: gather ──────────────────────────────────────────────────────────
async function readGaps(paths: string[]): Promise<GapEntry[]> {
  const all: GapEntry[] = [];
  for (const p of paths) {
    let raw: string;
    try {
      raw = await readFile(p, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as Partial<GapEntry>;
        if (entry.claim && entry.step) {
          all.push({
            runId: entry.runId ?? "",
            step: entry.step,
            claim: entry.claim,
            reason: entry.reason ?? "",
            ts: entry.ts ?? new Date().toISOString(),
          });
        }
      } catch { /* skip malformed line */ }
    }
  }
  return all;
}

// ── Step 4 helper: run a python script via uv ───────────────────────────────
type RunScriptResult = { exitCode: number; stdout: string; stderr: string };

const RUN_SCRIPT_TIMEOUT_MS = 60_000;
const RUN_SCRIPT_OUTPUT_MAX_BYTES = 1 * 1024 * 1024;

type OutputAccumulator = {
  value: string;
  bytes: number;
  truncated: boolean;
};

function appendBoundedOutput(acc: OutputAccumulator, chunk: Buffer | string, label: string): void {
  if (acc.truncated) return;
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = RUN_SCRIPT_OUTPUT_MAX_BYTES - acc.bytes;
  if (buf.length <= remaining) {
    acc.value += buf.toString("utf8");
    acc.bytes += buf.length;
    return;
  }
  if (remaining > 0) {
    acc.value += buf.subarray(0, remaining).toString("utf8");
    acc.bytes += remaining;
  }
  acc.value += `\n[${label} truncated at ${RUN_SCRIPT_OUTPUT_MAX_BYTES} bytes]\n`;
  acc.truncated = true;
}

async function runScript(scriptPath: string, args: string[]): Promise<RunScriptResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("uv", ["run", "--script", scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stdout: OutputAccumulator = { value: "", bytes: 0, truncated: false };
    const stderr: OutputAccumulator = { value: "", bytes: 0, truncated: false };
    let timedOut = false;
    let sigkillTimeout: NodeJS.Timeout | undefined;

    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (!proc.pid) return;
      try {
        process.kill(-proc.pid, signal);
      } catch {
        try { proc.kill(signal); } catch { /* already exited */ }
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      sigkillTimeout = setTimeout(() => {
        killProcessGroup("SIGKILL");
      }, 10_000);
    }, RUN_SCRIPT_TIMEOUT_MS);

    proc.stdout?.on("data", (c) => { appendBoundedOutput(stdout, c, "stdout"); });
    proc.stderr?.on("data", (c) => { appendBoundedOutput(stderr, c, "stderr"); });
    proc.on("error", (err) => {
      killProcessGroup("SIGTERM");
      if (sigkillTimeout) clearTimeout(sigkillTimeout);
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout: stdout.value,
        stderr: stderr.value || `spawn-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (sigkillTimeout) clearTimeout(sigkillTimeout);
      if (timedOut) {
        reject(new Error(`uv script timed out after ${RUN_SCRIPT_TIMEOUT_MS}ms: ${scriptPath}`));
        return;
      }
      resolve({ exitCode: code ?? -1, stdout: stdout.value, stderr: stderr.value });
    });
  });
}

// ── Step 5: validate against all fixtures ───────────────────────────────────
type FixtureValidation = {
  ok: boolean;
  fixtureCount: number;
  newFixturePassed: boolean;
  details: string[];
};

async function validateAgainstFixtures(opts: {
  stagedScriptPath: string;
  newFixturePath: string;
  fixturesDir: string;
}): Promise<FixtureValidation> {
  const details: string[] = [];

  // Run the new fixture explicitly first.
  const newRes = await runScript(opts.stagedScriptPath, ["--fixture", opts.newFixturePath]);
  const newFixturePassed = newRes.exitCode === 0;
  details.push(
    `[new-fixture] ${basename(opts.newFixturePath)} exit=${newRes.exitCode} ok=${newFixturePassed}`,
  );

  // Then run every other registered fixture; each must continue to pass.
  let regressionPasses = 0;
  let regressionTotal = 0;
  if (existsSync(opts.fixturesDir)) {
    const entries = await readdir(opts.fixturesDir).catch(() => []);
    for (const f of entries) {
      const p = join(opts.fixturesDir, f);
      if (p === opts.newFixturePath) continue;
      try {
        const s = await stat(p);
        if (!s.isFile()) continue;
      } catch { continue; }
      regressionTotal++;
      const r = await runScript(opts.stagedScriptPath, ["--fixture", p]);
      const ok = r.exitCode === 0;
      if (ok) regressionPasses++;
      details.push(`[regression] ${f} exit=${r.exitCode} ok=${ok}`);
    }
  }

  const ok = newFixturePassed && regressionPasses === regressionTotal;
  return {
    ok,
    fixtureCount: regressionTotal + 1,
    newFixturePassed,
    details,
  };
}

// ── Step 6 helper: produce a unified diff (active vs staged) ────────────────
async function buildDiff(activePath: string, stagedPath: string): Promise<string> {
  const active = existsSync(activePath) ? await readFile(activePath, "utf8") : "";
  const staged = await readFile(stagedPath, "utf8").catch(() => "");
  // v1: include both file bodies. The Judge gets concrete content.
  return [
    `--- ACTIVE: ${activePath}`,
    active || "(file does not exist; new script)",
    `+++ STAGED: ${stagedPath}`,
    staged,
  ].join("\n");
}

// ── Step 6: ask Judge for approval ──────────────────────────────────────────
async function requestJudgeApproval(opts: {
  team: TeamRuntime;
  judgeAgentName: string;
  proposal: ProposedChange;
  diff: string;
  validation: FixtureValidation;
  runsDir?: string;
  runId?: string;
}): Promise<{ approved: boolean; tokenId?: string }> {
  const justification = [
    `Verifier-script update for gap: ${opts.proposal.gap.claim}`,
    `Category: ${opts.proposal.category}`,
    `Approach: ${opts.proposal.approach}`,
    `Fixture: ${opts.proposal.fixturePath}`,
    `Regression command: ${opts.proposal.regressionCommand}`,
    `Validation: ok=${opts.validation.ok} fixtureCount=${opts.validation.fixtureCount}`,
    `Validation details:\n${opts.validation.details.join("\n")}`,
    "",
    "Diff:",
    opts.diff,
  ].join("\n");

  const message: TeamMessage = {
    id: crypto.randomUUID(),
    from: "learner",
    to: opts.judgeAgentName,
    summary: `Approve verifier-script update: ${opts.proposal.scriptName}`,
    message:
      `The Learner has staged ${opts.proposal.scriptName}. Review the diff, fixture, and validation output below.\n` +
      `If acceptable, call GrantApproval with op="verifier-script-update" and command=${opts.proposal.scriptName}.\n\n` +
      justification,
    ts: new Date().toISOString(),
  };
  const verdict = await opts.team.deliver(
    opts.judgeAgentName,
    message,
    opts.runId ? { runId: opts.runId } : undefined,
  );
  if (!verdict) return { approved: false };
  if (verdict.verdict !== "PASS") return { approved: false };

  // Legacy test path: runsDir/runId omitted → skip token verification.
  // Production callers (commands/learn.ts) always supply both.
  if (!opts.runsDir || !opts.runId) {
    return { approved: true, tokenId: undefined };
  }

  // Codex round-6 HIGH: judge PASS alone is NOT sufficient. The host-side
  // rename in promote() bypasses SafetyGuard's verifier-script-update
  // gate because no Pi Write/Edit hook fires for a controller-process
  // rename. Require that GrantApproval actually minted a token in
  // <runsDir>/<runId>/approvals/ for this script BEFORE returning
  // approved=true.
  const { hashArgs, verifyToken } = await import("../safety/approvals.js");
  const expectedArgsHash = hashArgs({ op: "verifier-script-update", command: opts.proposal.scriptName });
  let secret: string;
  try {
    secret = (await readFile(join(opts.runsDir, opts.runId, ".secret"), "utf8")).trim();
  } catch {
    return { approved: false };
  }
  // Phase 7 review fix (both rounds HIGH): the verifier promotion
  // path is a Layer-C approval boundary; it must enforce the same
  // pauseEpoch + emergencyStop gate as SafetyGuard.findValidApproval.
  // Fail closed on safety config load failure (corrupted safety.json
  // must not silently let pre-stop tokens slip through). And if
  // emergencyStop is asserted, refuse unconditionally.
  let currentPauseEpoch = 0;
  let emergencyStopped = false;
  try {
    const { loadSafetyConfig } = await import("../config.js");
    const safety = await loadSafetyConfig();
    if (safety.approvalWatcher?.emergencyStop === true) emergencyStopped = true;
    if (typeof safety.approvalWatcher?.pauseEpoch === "number") {
      currentPauseEpoch = safety.approvalWatcher.pauseEpoch;
    }
  } catch {
    // Fail closed on config load failure.
    return { approved: false };
  }
  if (emergencyStopped) {
    return { approved: false };
  }
  const approvalsDir = join(opts.runsDir, opts.runId, "approvals");
  const files = await readdir(approvalsDir).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const tokenPath = join(approvalsDir, file);
      const token = JSON.parse(await readFile(tokenPath, "utf8"));
      if (token.consumed) continue;
      if (token.op !== "verifier-script-update") continue;
      if (token.argsHash !== expectedArgsHash) continue;
      if (token.runId !== opts.runId) continue;
      if (!verifyToken(secret, token)) continue;
      // Phase 7 review fix: epoch equality on top of signature verify.
      if (token.pauseEpoch !== currentPauseEpoch) continue;
      // Atomic consume: rename to .consumed so a second promote can't replay.
      const consumedPath = tokenPath + ".consumed";
      try {
        await rename(tokenPath, consumedPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        continue;
      }
      return { approved: true, tokenId: token.tokenId };
    } catch {
      continue;
    }
  }
  return { approved: false };
}

// ── Step 7: atomic promotion + archive + CHANGELOG ──────────────────────────
async function promote(opts: {
  proposal: ProposedChange;
  scriptsDir: string;
  stagingDir: string;
  versionsDir: string;
  changelogPath: string;
  validation: FixtureValidation;
}): Promise<string> {
  const stagedPath = join(opts.stagingDir, opts.proposal.scriptName);
  const activePath = join(opts.scriptsDir, opts.proposal.scriptName);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const versionDir = join(opts.versionsDir, ts);
  await mkdir(versionDir, { recursive: true });

  // Archive prior version (if any) before overwriting.
  if (existsSync(activePath)) {
    const prior = await readFile(activePath, "utf8");
    await writeFile(join(versionDir, opts.proposal.scriptName), prior);
  }

  // Atomic rename: same filesystem (both paths under scriptsDir).
  await mkdir(dirname(activePath), { recursive: true });
  try {
    await rename(stagedPath, activePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EXDEV") {
      // Cross-filesystem move (rare; possible under bind-mounts). Fall back
      // to copy + unlink. Both targets are under verifier-scripts so the
      // copy contents are bounded.
      const content = await readFile(stagedPath);
      await writeFile(activePath, content);
      await unlink(stagedPath);
    } else {
      throw err;
    }
  }

  // CHANGELOG entry — append-only.
  const entry =
    `\n## ${ts} — ${opts.proposal.scriptName}\n` +
    `- gap: ${opts.proposal.gap.claim}\n` +
    `- category: ${opts.proposal.category}\n` +
    `- fixtures-passed: ${opts.validation.fixtureCount}\n` +
    `- archive: ${join(opts.versionsDir, ts, opts.proposal.scriptName)}\n`;
  await appendFile(opts.changelogPath, entry);

  return ts;
}

// ── Steps 1–3: ask the learner agent for proposals ──────────────────────────
async function dispatchLearnerForProposals(opts: {
  team: TeamRuntime;
  learnerAgentName: string;
  gaps: GapEntry[];
  scriptsDir: string;
  runId?: string;
}): Promise<ProposedChange[]> {
  if (opts.gaps.length === 0) return [];
  const message: TeamMessage = {
    id: crypto.randomUUID(),
    from: "system",
    to: opts.learnerAgentName,
    summary: `Classify and design proposals for ${opts.gaps.length} verifier gap(s)`,
    message:
      `You are the Learner. Read the following gaps and the existing scripts under ${opts.scriptsDir}. ` +
      `For each addressable gap, produce a staged Python script under .staging/ and a fixture under .fixtures/, ` +
      `then call VerdictEmit with one entry in 'artifacts' per staged script (filename only). ` +
      `Set 'handoffHint' to a JSON array of { gap, category, scriptName, approach, fixturePath, regressionCommand } objects.\n\n` +
      `STRICT REQUIREMENTS on every proposal:\n` +
      `- scriptName MUST be a Python script ending in .py — e.g. "verify_divide_guards.py". Shell, JS, or any non-Python extension will be rejected by the orchestrator's safe-name check (regex: /^[A-Za-z][A-Za-z0-9_.-]{0,62}\\.py$/).\n` +
      `- scriptName must be a bare basename (no path separators, no dotfiles, no '..'). The orchestrator joins it under .staging/, so any path traversal causes the proposal to be silently discarded.\n` +
      `- fixturePath must also be a bare basename ending in .json (or whatever your runScript helper expects), placed under .fixtures/.\n` +
      `- Each proposal must be self-contained: the .py file under .staging/ is what the orchestrator will validate and promote unmodified.\n\n` +
      `GAPS:\n${opts.gaps.map((g, n) => `${n + 1}. step=${g.step} claim=${g.claim}`).join("\n")}\n`,
    ts: new Date().toISOString(),
  };
  const verdict = await opts.team.deliver(
    opts.learnerAgentName,
    message,
    opts.runId ? { runId: opts.runId } : undefined,
  );
  return parseProposalsFromVerdict(verdict, opts.gaps);
}

// Strict scriptName grammar: bare basename, [A-Za-z0-9_.-], 1..64 chars,
// must end in .py (verifier scripts are Python). Rejects path separators,
// `..`, dotfiles, leading dot, etc. Codex P3.5 round-1 C-5: prevent path
// traversal in orchestrator's join(stagingDir, proposal.scriptName).
const SCRIPT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,62}\.py$/;
function isSafeScriptName(name: unknown): name is string {
  return typeof name === "string" && SCRIPT_NAME.test(name) && !name.includes("..");
}

// Codex P3.5 round-4 H-7: fixturePath comes from learner-supplied proposal;
// must stay under <fixturesDir>. Reject path-traversal via `..` or absolute
// paths outside the dir. Bare basename grammar matches scriptName — fixture
// files are project-local artifacts, not free paths.
function isSafeFixtureBasename(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name);
}

export function parseProposalsFromVerdict(
  verdict: VerdictPayload | undefined,
  gaps: GapEntry[],
): ProposedChange[] {
  if (!verdict?.handoffHint) return [];
  try {
    const parsed = JSON.parse(verdict.handoffHint) as Array<Partial<ProposedChange>>;
    if (!Array.isArray(parsed)) return [];
    const proposals: ProposedChange[] = [];
    for (const p of parsed) {
      if (!p.scriptName || !p.fixturePath) continue;
      // Refuse any proposal whose scriptName isn't a safe basename. The
      // orchestrator otherwise would join() an attacker-controlled path
      // segment into stagingDir/scriptsDir.
      if (!isSafeScriptName(p.scriptName)) continue;
      // Same rule for fixturePath — drop anything that isn't a safe basename.
      // The orchestrator joins into fixturesDir; absolute paths or `..`
      // segments would otherwise let the learner steer reads/writes outside
      // the fixtures directory.
      const fixtureBasename = (p.fixturePath as string).split(/[\\/]/).pop() ?? "";
      if (!isSafeFixtureBasename(fixtureBasename)) continue;
      const gap = (p.gap as GapEntry | undefined) ??
        gaps.find((g) => g.claim === (p as any).gapClaim) ??
        gaps[0];
      if (!gap) continue;
      proposals.push({
        gap,
        category: (p.category as GapCategory) ?? "new-domain-script",
        scriptName: p.scriptName,
        approach: p.approach ?? "",
        // Re-anchor to fixturesDir at promotion time — normalize to a basename
        // so the orchestrator's filesystem ops never see a free path.
        fixturePath: fixtureBasename,
        regressionCommand: p.regressionCommand ?? "",
      });
    }
    return proposals;
  } catch {
    return [];
  }
}

// ── Public entrypoint ──────────────────────────────────────────────────────
export async function runLearner(cfg: LearnerConfig): Promise<LearnerResult> {
  // Step 1: gather.
  const gaps = await readGaps(cfg.gapsPaths);

  // Step 2 + 3: dispatch creative reasoning to the learner agent.
  const proposals = await dispatchLearnerForProposals({
    team: cfg.team,
    learnerAgentName: cfg.learnerAgentName,
    gaps,
    scriptsDir: cfg.scriptsDir,
    runId: cfg.runId,
  });

  let approved = 0;
  let promoted = 0;
  const escalations: string[] = [];

  await mkdir(cfg.stagingDir, { recursive: true });
  await mkdir(cfg.versionsDir, { recursive: true });
  await mkdir(cfg.fixturesDir, { recursive: true });

  for (const proposal of proposals) {
    if (proposal.category === "unaddressable-escalation") {
      escalations.push(`${proposal.gap.step}: ${proposal.gap.claim}`);
      continue;
    }

    const stagedPath = join(cfg.stagingDir, proposal.scriptName);
    if (!existsSync(stagedPath)) {
      escalations.push(`missing staged file for ${proposal.scriptName}`);
      continue;
    }

    // Step 5: validate. fixturePath is now a sanitized basename — anchor it
    // under cfg.fixturesDir so the orchestrator's runScript invocation never
    // sees a free path.
    const validation = await validateAgainstFixtures({
      stagedScriptPath: stagedPath,
      newFixturePath: join(cfg.fixturesDir, proposal.fixturePath),
      fixturesDir: cfg.fixturesDir,
    });

    if (!validation.ok) {
      escalations.push(
        `validation-failed: ${proposal.scriptName} (newFixturePassed=${validation.newFixturePassed})`,
      );
      // Clean up staged file so it never lingers as a partial promotion.
      try { await unlink(stagedPath); } catch { /* best-effort */ }
      continue;
    }

    // Step 6: Judge approval.
    const activePath = join(cfg.scriptsDir, proposal.scriptName);
    const diff = await buildDiff(activePath, stagedPath);
    const approval = await requestJudgeApproval({
      team: cfg.team,
      judgeAgentName: cfg.judgeAgentName,
      proposal,
      diff,
      validation,
      runsDir: cfg.runsDir,
      runId: cfg.runId,
    });

    if (!approval.approved) {
      escalations.push(`judge-denied: ${proposal.scriptName}`);
      try { await unlink(stagedPath); } catch { /* best-effort */ }
      continue;
    }
    approved++;

    // Step 7: promote.
    const version = await promote({
      proposal,
      scriptsDir: cfg.scriptsDir,
      stagingDir: cfg.stagingDir,
      versionsDir: cfg.versionsDir,
      changelogPath: cfg.changelogPath,
      validation,
    });
    promoted++;
    cfg.onPromote?.(proposal.scriptName, version);
  }

  // Step 8: report.
  const reportRunDir = cfg.reportRunDir ?? cfg.stagingDir;
  const learningDir = cfg.reportRunDir ? join(reportRunDir) : reportRunDir;
  await mkdir(learningDir, { recursive: true });
  const reportPath = join(learningDir, "report.md");
  const reportText = [
    `# Learner Report`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `- Gaps processed: ${gaps.length}`,
    `- Scripts proposed: ${proposals.length}`,
    `- Scripts approved: ${approved}`,
    `- Scripts promoted: ${promoted}`,
    ``,
    `## Escalations`,
    escalations.length === 0 ? "(none)" : escalations.map((e) => `- ${e}`).join("\n"),
    ``,
    `## Promoted scripts`,
    proposals
      .filter((p) => p.category !== "unaddressable-escalation")
      .map((p) => `- ${p.scriptName} (${p.category})`).join("\n") || "(none)",
    "",
  ].join("\n");
  await writeFile(reportPath, reportText);

  return {
    gapsProcessed: gaps.length,
    scriptsProposed: proposals.length,
    scriptsApproved: approved,
    scriptsPromoted: promoted,
    escalations,
    reportPath,
  };
}

// Exposed for unit tests so we can verify each step independently of the
// full orchestrator harness.
export const _testing = {
  readGaps,
  validateAgainstFixtures,
  promote,
  buildDiff,
  parseProposalsFromVerdict,
};
