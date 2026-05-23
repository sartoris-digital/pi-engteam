#!/usr/bin/env node
// Workflow QA Harness — runs all 13 workflows with bounded test
// scenarios and evaluates acceptance criteria.
//
// Usage:
//   node scripts/workflow-qa-harness.mjs
//   node scripts/workflow-qa-harness.mjs --workflow triage
//   node scripts/workflow-qa-harness.mjs --only-failed   # re-run failures from last report
//
// Requires: Pi running in tmux session "pi-engineering-qa" in the
// project directory. Start with:
//   tmux new-session -d -s pi-engineering-qa
//   tmux send-keys -t pi-engineering-qa "cd <projDir> && pi" Enter

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────
const TMUX_SESSION  = "pi-engineering-qa";
const RUNS_DIR      = join(homedir(), ".pi", "engineering-team", "runs");
const QA_REPORT     = join(homedir(), ".pi", "engineering-team", "qa-report.json");
const TIMEOUT_MS    = 75 * 60 * 1000;  // 75 min per workflow (GHCP slower; review/judge-gate up to 1800s each)
const POLL_INTERVAL = 3000;
const PROJECT_DIR   = process.cwd();

// ── CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const workflowIdx = args.indexOf("--workflow");
const only = workflowIdx >= 0 ? (args[workflowIdx + 1] ?? null) : null;
const onlyFailed = args.includes("--only-failed");

// ── Scenario definitions ─────────────────────────────────────────────
// Each scenario: { workflow, goal, accept: (runDir) => { pass, reason } }
const SCENARIOS = [
  {
    workflow: "triage",
    goal: "There is a suspected race condition in the drain-lock.ts file where two concurrent calls to acquireDrainLock() in the same process don't correctly throw the second time. Investigate and classify severity.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "triage-summary", minBytes: 400, mustContain: [/P[0-3]|severity|Severity/] },
      ]);
    },
  },
  {
    workflow: "investigate",
    goal: "Investigate why dirSize() in activity-pruner.ts does a full recursive stat walk on every prune call. Analyze the performance impact and what conditions would make it expensive.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "investigation", minBytes: 400, mustContain: [/hypothesis|root.cause|analysis|finding/i] },
      ]);
    },
  },
  {
    workflow: "debug",
    goal: "Debug the following observed behavior: KillSwitchPoller.stop() calls flush() on the WAL but the KillSwitchPoller does not own a WAL. Identify if this is a documentation bug, a missing feature, or a real integration issue.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "debug", minBytes: 300, mustContain: [/cause|issue|finding|conclusion/i] },
      ]);
    },
  },
  {
    workflow: "fix-loop",
    goal: "The drain-lock probe file (.rollback.lock.probe) is never cleaned up when configDir does not exist at resolve time. Write a fix and verify it passes the existing drain-lock tests.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "fix", minBytes: 200, mustContain: [/fix|change|patch|resolved/i] },
      ]);
    },
  },
  {
    workflow: "verify",
    goal: "Verify that the CounterWal.computeTotals() function correctly merges checkpoint + WAL tail so that totals are monotonic. Use the existing counter-storm test as the oracle.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "verdict", minBytes: 50, mustContain: [/PASS|FAIL|pass|fail/i] },
      ]);
    },
  },
  {
    workflow: "plan-build-review",
    goal: "Add a getDiskUsageStats() exported function to src/team/activity-pruner.ts that returns { canonicalBytes: number, mirrorBytes: number, totalBytes: number } by scanning <runsDir>/_activity/ and <runsDir>/<runId>/agent-activity.jsonl entries.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "plan",   minBytes: 200 },
        { name: "review", minBytes: 100 },
      ]);
    },
  },
  {
    workflow: "plan-build-review-fix",
    goal: "Add a configurable maxProbeFiles option to the probe-pi-provider.mjs canary section so operators can limit how many canary files get planted per probe run. Default should be 3 (current behavior).",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "plan",   minBytes: 200 },
        { name: "review", minBytes: 100 },
      ]);
    },
  },
  {
    workflow: "spec-plan-build-review",
    goal: "Spec, plan, build, and review a minimal RateLimiter utility class in src/observability/rate-limiter.ts: takes { maxPerWindow, windowMs } and exposes tryAcquire() → boolean. Include unit tests.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "spec",   minBytes: 300 },
        { name: "plan",   minBytes: 200 },
        { name: "review", minBytes: 100 },
      ]);
    },
  },
  {
    workflow: "refactor-campaign",
    goal: "Refactor the acquireAt() function in src/team/drain-lock.ts to extract the stale-lock-reclaim logic into a named helper function recoverStaleLock(lockPath). Keep behavior identical.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "refactor", minBytes: 200, mustContain: [/refactor|change|extract|rename/i] },
      ]);
    },
  },
  {
    workflow: "migration",
    goal: "Migrate the aggregate() method in src/observability/textfile-exporter.ts to use a named constant AGGREGATOR_LOCK_FILE = '.aggregator.lock' instead of the inline string. Update any references in the test file too.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "migration", minBytes: 200, mustContain: [/migrat|chang|constant|rename/i] },
      ]);
    },
  },
  {
    workflow: "doc-backfill",
    goal: "Add JSDoc comments to every exported function and type in src/team/schema-versioning.ts. Each comment should describe the purpose, parameters, and return value.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "doc", minBytes: 50, mustContain: [/JSDoc|@param|@returns|documentation/i] },
      ]);
    },
  },
  {
    workflow: "issue-analyze",
    goal: "Analyze this issue: 'The rollback-standalone.mjs script does not handle the case where <configDir>/processes/*.pid files reference stale PIDs gracefully — it tries SIGTERM on dead PIDs which throws ESRCH.' Classify, route, and recommend next steps.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "analysis",          minBytes: 300 },
        { name: "routing-recommendation", minBytes: 100 },
      ]);
    },
  },
  {
    workflow: "consult",
    goal: "What is the best approach to add structured OpenTelemetry tracing to the RunActivityQueue.enqueue() hot path without adding more than 1ms of per-event latency? Consider span overhead, sampling, and the existing CounterWal pattern.",
    accept(runDir) {
      return checkArtifacts(runDir, [
        { name: "synthesis", minBytes: 400, mustContain: [/trace|OTEL|OpenTelemetry|latency|sampling/i] },
      ]);
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────
function checkArtifacts(runDir, checks) {
  const stateFile = join(runDir, "state.json");
  if (!existsSync(stateFile)) return { pass: false, reason: "state.json missing" };

  let state;
  try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch {
    return { pass: false, reason: "state.json unreadable" };
  }

  if (state.status !== "succeeded") {
    const lastErr = findLastError(runDir);
    return { pass: false, reason: `status=${state.status}${lastErr ? ": " + lastErr : ""}` };
  }

  // Check each expected artifact
  for (const check of checks) {
    const match = findArtifact(runDir, check.name);
    if (!match) return { pass: false, reason: `artifact "${check.name}" not found in ${runDir}` };
    const content = readFileSync(match, "utf8");
    if (content.length < (check.minBytes ?? 0)) {
      return { pass: false, reason: `artifact "${check.name}" too small (${content.length} < ${check.minBytes})` };
    }
    for (const re of (check.mustContain ?? [])) {
      if (!re.test(content)) {
        return { pass: false, reason: `artifact "${check.name}" missing pattern ${re}` };
      }
    }
  }
  return { pass: true, reason: "all checks passed" };
}

function findArtifact(runDir, name) {
  try {
    const files = readdirSync(runDir);
    // Prefer exact match, then prefix match, then substring
    const exact = files.find(f => f === name + ".md" || f === name + ".json");
    if (exact) return join(runDir, exact);
    const prefix = files.find(f => f.startsWith(name));
    if (prefix) return join(runDir, prefix);
    const sub = files.find(f => f.includes(name));
    if (sub) return join(runDir, sub);
  } catch { /* ignore */ }
  return null;
}

function findLastError(runDir) {
  try {
    const eventsFile = join(runDir, "events.jsonl");
    if (!existsSync(eventsFile)) return null;
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === "error" || ev.category === "error" || ev.summary?.includes("error")) {
          return ev.summary ?? ev.text ?? null;
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function latestRunIdBefore(cutoff) {
  try {
    const dirs = readdirSync(RUNS_DIR)
      .filter(d => UUID_RE.test(d))
      .map(d => ({ id: d, mtime: statSync(join(RUNS_DIR, d)).mtimeMs }))
      .filter(d => d.mtime > cutoff)
      .sort((a, b) => b.mtime - a.mtime);
    return dirs[0]?.id ?? null;
  } catch { return null; }
}

function sendToTmux(command) {
  spawnSync("tmux", ["send-keys", "-t", TMUX_SESSION, command, "Enter"], { stdio: "ignore" });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function pollRunCompletion(runId, timeoutMs) {
  const stateFile = join(RUNS_DIR, runId, "state.json");
  const deadline = Date.now() + timeoutMs;
  let lastResumedAt = 0;
  while (Date.now() < deadline) {
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        if (["succeeded", "failed", "halted"].includes(state.status)) {
          return state.status;
        }
        // Auto-resume waiting_user pauses (e.g. spec review checkpoints)
        if (state.status === "waiting_user" && Date.now() - lastResumedAt > 10_000) {
          log(`  [auto-resume] run paused for user — sending /run-resume ${runId.slice(0, 8)}`);
          sendToTmux(`/run-resume ${runId}`);
          lastResumedAt = Date.now();
        }
      } catch { /* retry */ }
    }
    await sleep(POLL_INTERVAL);
  }
  return "timeout";
}

async function waitForRunToAppear(cutoff, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runId = latestRunIdBefore(cutoff);
    if (runId) return runId;
    await sleep(1000);
  }
  return null;
}

function log(msg) { process.stdout.write(msg + "\n"); }
function logOk(msg) { log(`  ✓ ${msg}`); }
function logFail(msg) { log(`  ✗ ${msg}`); }

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(RUNS_DIR, { recursive: true });

  // Filter scenarios
  let scenarios = SCENARIOS;
  if (only) scenarios = scenarios.filter(s => s.workflow === only);
  if (onlyFailed && existsSync(QA_REPORT)) {
    const prev = JSON.parse(readFileSync(QA_REPORT, "utf8"));
    const failedNames = new Set(prev.results.filter(r => !r.pass).map(r => r.workflow));
    scenarios = scenarios.filter(s => failedNames.has(s.workflow));
  }

  log(`\n${"═".repeat(70)}`);
  log(`Pi Engineering — Workflow QA Campaign`);
  log(`Scenarios: ${scenarios.length}  |  Timeout: ${TIMEOUT_MS / 1000}s each`);
  log(`Runs dir:  ${RUNS_DIR}`);
  log(`Tmux:      ${TMUX_SESSION}`);
  log(`${"═".repeat(70)}\n`);

  const results = [];
  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    log(`[ ${scenario.workflow} ]`);
    log(`  Goal: ${scenario.goal.slice(0, 80)}…`);

    const startCutoff = Date.now() - 500;
    const cmd = `/run-start ${scenario.workflow} "${scenario.goal.replace(/"/g, '\\"')}"`;
    sendToTmux(cmd);

    log(`  Waiting for run to appear…`);
    const runId = await waitForRunToAppear(startCutoff, 20_000);
    if (!runId) {
      logFail("run never appeared in runs dir (did Pi receive the command?)");
      results.push({ workflow: scenario.workflow, pass: false, reason: "run never started", runId: null });
      failed++;
      continue;
    }
    log(`  Run ID: ${runId}`);

    const finalStatus = await pollRunCompletion(runId, TIMEOUT_MS);
    if (finalStatus === "timeout") {
      logFail(`timed out after ${TIMEOUT_MS / 1000}s`);
      results.push({ workflow: scenario.workflow, pass: false, reason: "timeout", runId });
      failed++;
      continue;
    }
    log(`  Status: ${finalStatus}`);

    const runDir = join(RUNS_DIR, runId);
    const { pass, reason } = scenario.accept(runDir);
    if (pass) {
      logOk(`PASS — ${reason}`);
      passed++;
    } else {
      logFail(`FAIL — ${reason}`);
      failed++;
    }
    results.push({ workflow: scenario.workflow, pass, reason, runId, status: finalStatus });

    // Brief pause between runs to avoid hammering the provider
    await sleep(2000);
  }

  log(`\n${"═".repeat(70)}`);
  log(`Results: ${passed} passed, ${failed} failed of ${scenarios.length} scenarios`);
  log(`${"═".repeat(70)}`);
  for (const r of results) {
    const mark = r.pass ? "✓" : "✗";
    log(`  ${mark} ${r.workflow.padEnd(24)} ${r.pass ? "PASS" : "FAIL"} — ${r.reason}`);
  }

  writeFileSync(QA_REPORT, JSON.stringify({ ts: new Date().toISOString(), results }, null, 2));
  log(`\nReport written: ${QA_REPORT}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
