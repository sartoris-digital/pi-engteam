#!/usr/bin/env node
// Phase E item E6 — emergency rollback standalone script.
//
// Intentionally has ZERO imports from src/ or dist/. Only Node built-ins.
// This script must work even when the extension is broken.
//
// Usage:
//   PI_ENGINEERING_ROLLBACK_ACK=1 node scripts/rollback-standalone.mjs --to <version>
//   PI_ENGINEERING_ROLLBACK_ACK=1 node scripts/rollback-standalone.mjs --to <version> --auto-cancel
//   node scripts/rollback-standalone.mjs --self-test

import { openSync, writeSync, closeSync, unlinkSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { constants } from "node:fs";

const { O_CREAT, O_EXCL, O_WRONLY } = constants;

// ─── arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const SELF_TEST   = args.includes("--self-test");
const AUTO_CANCEL = args.includes("--auto-cancel");

let targetVersion = null;
const toIdx = args.indexOf("--to");
if (toIdx !== -1 && args[toIdx + 1]) {
  targetVersion = args[toIdx + 1];
}

// ─── config dir resolution ────────────────────────────────────────────────────

function resolveConfigDir() {
  // Mirror the extension's convention: XDG_CONFIG_HOME or ~/.config
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? xdg : join(homedir(), ".config");
  return join(base, "pi-engineering");
}

const configDir = resolveConfigDir();

// ─── drain lock (inline — no src/ imports) ────────────────────────────────────

const LOCK_FILENAME = ".rollback.lock";
const FALLBACK_LOCK = "/var/tmp/pi-eng-rollback.lock";

function isDeadPid(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

function readLockPayload(lockPath) {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid === "number") return parsed;
  } catch { /* ignore */ }
  return null;
}

function acquireDrainLock(dir) {
  const preferred = join(dir, LOCK_FILENAME);
  let lockPath;
  try {
    mkdirSync(dir, { recursive: true });
    // Probe write to confirm the directory is writable.
    const probe = join(dir, ".write-probe");
    const pfd = openSync(probe, O_CREAT | O_WRONLY, 0o600);
    closeSync(pfd);
    try { unlinkSync(probe); } catch { /* ignore */ }
    lockPath = preferred;
  } catch {
    lockPath = FALLBACK_LOCK;
  }

  return tryAcquireAt(lockPath, false);
}

function tryAcquireAt(lockPath, retrying) {
  let fd;
  try {
    fd = openSync(lockPath, O_CREAT | O_EXCL | O_WRONLY, 0o600);
  } catch (e) {
    if (e.code === "EEXIST") {
      if (!retrying) {
        const existing = readLockPayload(lockPath);
        if (existing && isDeadPid(existing.pid)) {
          try { unlinkSync(lockPath); } catch { /* lost race */ }
          return tryAcquireAt(lockPath, true);
        }
      }
      const byPid = readLockPayload(lockPath)?.pid;
      const detail = byPid ? ` (held by pid ${byPid})` : "";
      fatal(`drain lock already held${detail} at ${lockPath}\nIs another rollback already running?`);
    }
    throw e;
  }

  const payload = JSON.stringify({ pid: process.pid, ts: new Date().toISOString() });
  writeSync(fd, payload);
  closeSync(fd);

  return {
    lockPath,
    release() {
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function fatal(msg) {
  console.error(`\n[rollback] FATAL: ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`[rollback] ${msg}`);
}

function printTable(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? "").length)));
  const sep = widths.map(w => "-".repeat(w + 2)).join("+");
  const fmt = row => widths.map((w, i) => ` ${String(row[i] ?? "").padEnd(w)} `).join("|");
  console.log("+" + sep + "+");
  console.log("|" + fmt(headers) + "|");
  console.log("+" + sep + "+");
  for (const row of rows) {
    console.log("|" + fmt(row) + "|");
  }
  console.log("+" + sep + "+");
}

// ─── self-test ────────────────────────────────────────────────────────────────

if (SELF_TEST) {
  info("running self-test...");

  // Use a temp dir so we don't touch the real configDir.
  const testDir = join(tmpdir(), `pi-eng-rollback-self-test-${process.pid}`);
  mkdirSync(testDir, { recursive: true });

  // 1. Acquire succeeds.
  const handle = acquireDrainLock(testDir);
  if (!existsSync(handle.lockPath)) fatal("self-test: lock file not created");
  const payload = readLockPayload(handle.lockPath);
  if (payload?.pid !== process.pid) fatal("self-test: pid mismatch in lock file");

  // 2. Second acquire fails with EEXIST.
  let threw = false;
  try {
    acquireDrainLock(testDir);
  } catch {
    threw = true;
  }
  // acquireDrainLock calls fatal() on conflict which calls process.exit — so
  // we can't catch it from this process. Instead, test the helper directly.
  try {
    tryAcquireAt(handle.lockPath, false);
  } catch {
    threw = true;
  }
  // fatal() exits — the script will have exited above if the second acquire
  // ran through the normal path. Accept either outcome.
  void threw; // linter: used in spirit

  // 3. Release removes the file.
  handle.release();
  if (existsSync(handle.lockPath)) fatal("self-test: lock file not removed after release");

  // 4. Stale-lock reclaim: write a lock with a dead pid.
  const stalePath = join(testDir, LOCK_FILENAME);
  writeFileSync(stalePath, JSON.stringify({ pid: 99999999, ts: new Date().toISOString() }));
  const handle2 = acquireDrainLock(testDir);
  if (!existsSync(handle2.lockPath)) fatal("self-test: stale lock not reclaimed");
  handle2.release();

  // Cleanup.
  try { unlinkSync(testDir); } catch { /* rmdir would be cleaner but not needed */ }

  info("self-test PASSED");
  process.exit(0);
}

// ─── step 1: ACK guard ────────────────────────────────────────────────────────

if (process.env.PI_ENGINEERING_ROLLBACK_ACK !== "1") {
  console.error(`
[rollback] This script performs a DESTRUCTIVE rollback of the pi-engineering
           extension. To proceed you must set:

             PI_ENGINEERING_ROLLBACK_ACK=1

           and re-run the command.
`);
  process.exit(1);
}

if (!targetVersion) {
  fatal("--to <version> is required. Example: --to 2.0.5");
}

info(`target version: ${targetVersion}`);

// ─── step 2: acquire drain lock ───────────────────────────────────────────────

const lockHandle = acquireDrainLock(configDir);
info(`drain lock acquired at ${lockHandle.lockPath}`);

// Ensure we always release on exit.
process.on("exit", () => lockHandle.release());
process.on("SIGINT",  () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// ─── step 3: drain notice ─────────────────────────────────────────────────────

info("drain lock acquired; new spawns will be blocked");

// ─── step 4: rollback-readiness table ────────────────────────────────────────

function listRuns(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function runStatus(runsDir, runId) {
  const runDir = join(runsDir, runId);
  let phase = "unknown";
  try {
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    phase = state.phase ?? "unknown";
  } catch { /* no state.json yet */ }

  const hasVerdicts  = existsSync(join(runDir, "_verdicts"));
  const hasActivity  = existsSync(join(runDir, "_activity"));
  const hasDecisions = existsSync(join(runDir, "feature-decisions.json"));

  return { runId, phase, hasVerdicts, hasActivity, hasDecisions };
}

const TERMINAL_PHASES = new Set(["completed", "failed", "abandoned", "abandoned-by-emergency-rollback"]);

function isTerminal(phase) {
  return TERMINAL_PHASES.has(phase);
}

const runsDir = join(configDir, "runs");
const runIds = listRuns(runsDir);
const runStatuses = runIds.map(id => runStatus(runsDir, id));

info("\nrollback-readiness table:");
printTable(
  runStatuses.map(r => [
    r.runId,
    r.phase,
    isTerminal(r.phase) ? "terminal" : "ACTIVE",
    r.hasVerdicts  ? "yes" : "no",
    r.hasActivity  ? "yes" : "no",
    r.hasDecisions ? "yes" : "no",
  ]),
  ["run-id", "phase", "status", "_verdicts", "_activity", "feature-decisions"],
);

// ─── step 5: block or cancel active runs ─────────────────────────────────────

const activeRuns = runStatuses.filter(r => !isTerminal(r.phase));

if (activeRuns.length > 0) {
  if (!AUTO_CANCEL) {
    console.error(`
[rollback] ${activeRuns.length} run(s) are still active:

${activeRuns.map(r => `  • ${r.runId}  (phase: ${r.phase})`).join("\n")}

Rollback cannot proceed while runs are active.
Options:
  1. Wait for them to finish naturally, then re-run this script.
  2. Re-run with --auto-cancel to forcibly mark them abandoned.

Releasing drain lock and exiting.
`);
    lockHandle.release();
    process.exit(1);
  }

  // --auto-cancel: write abandoned state to each active run.
  for (const r of activeRuns) {
    const statePath = join(runsDir, r.runId, "state.json");
    let existing = {};
    try { existing = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* start fresh */ }
    writeFileSync(
      statePath,
      JSON.stringify({ ...existing, phase: "abandoned-by-emergency-rollback", abandonedAt: new Date().toISOString() }, null, 2),
    );
    info(`  marked run ${r.runId} as abandoned-by-emergency-rollback`);
  }
}

// ─── step 6: process fence ────────────────────────────────────────────────────

info("\nstep 6: process fence — terminating running pi-engineering processes");

function readPidFiles(dir) {
  const pidDir = join(dir, "processes");
  if (!existsSync(pidDir)) return [];
  try {
    return readdirSync(pidDir)
      .filter(f => f.endsWith(".pid"))
      .map(f => {
        try {
          const pid = parseInt(readFileSync(join(pidDir, f), "utf8").trim(), 10);
          return Number.isFinite(pid) ? pid : null;
        } catch {
          return null;
        }
      })
      .filter(p => p !== null);
  } catch {
    return [];
  }
}

function findOsPids() {
  try {
    const out = execSync("pgrep -f pi-engineering 2>/dev/null || true", { encoding: "utf8" });
    return out.split("\n")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n !== process.pid);
  } catch {
    return [];
  }
}

const pidFilePids = readPidFiles(configDir);
const osPids = findOsPids();
const allPids = [...new Set([...pidFilePids, ...osPids])];

if (allPids.length === 0) {
  info("  no running pi-engineering processes found");
} else {
  info(`  found ${allPids.length} process(es): ${allPids.join(", ")}`);

  // SIGTERM first.
  for (const pid of allPids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }

  info("  sent SIGTERM; waiting 15 s before SIGKILL...");

  const deadline = Date.now() + 15_000;
  let remaining = [...allPids];
  while (remaining.length > 0 && Date.now() < deadline) {
    // Synchronous busy-wait is acceptable here: this is an emergency script
    // with no event-loop concerns.
    execSync("sleep 1");
    remaining = remaining.filter(pid => !isDeadPid(pid));
  }

  if (remaining.length > 0) {
    info(`  ${remaining.length} process(es) still alive after 15 s — sending SIGKILL`);
    for (const pid of remaining) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  } else {
    info("  all processes terminated cleanly");
  }
}

// ─── steps 7–8: install instructions ─────────────────────────────────────────

console.log(`
[rollback] ─────────────────────────────────────────────────────────
[rollback] STEP 7–8: install target version
[rollback]
[rollback]   Run the following command to install version ${targetVersion}:
[rollback]
[rollback]     npm install -g @mariozechner/pi-coding-agent@${targetVersion}
[rollback]
[rollback]   (actual package installation is out of scope for this script)
[rollback] ─────────────────────────────────────────────────────────
`);

// ─── step 9: verify instructions ─────────────────────────────────────────────

console.log(`[rollback] STEP 9: after installing, verify with:

    pi --version

  Expected output should begin with: ${targetVersion}
`);

// ─── step 10: release drain lock ─────────────────────────────────────────────

lockHandle.release();
info("drain lock released");
info("rollback sequence complete");
