#!/usr/bin/env node
// Rollback readiness checker for pi-engineering runs.
//
// Usage:
//   node scripts/rollback-readiness.mjs
//   PI_ENGINEERING_RUNS_DIR=<path> node scripts/rollback-readiness.mjs
//
// Prints a table of active runs and their downgrade safety status.
// Exits 0 if all runs are safe or terminal, exits 1 if any active run is unsafe.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Re-implement the core logic inline so the script has no compiled-TS dep at runtime.
// The canonical implementation lives in src/team/schema-versioning.ts.

const LEGACY_SCHEMA_VERSION = "2.0.x";

const ARTIFACT_REGISTRY = [
  { path: "state.json",             class: "byte-compatible", readableBy: ["2.0.x", "2.1+"] },
  { path: "events.jsonl",           class: "byte-compatible", readableBy: ["2.0.x", "2.1+"] },
  { path: "state.v2.json",          class: "side-car",        readableBy: ["2.1+"] },
  { path: "_verdicts/",             class: "side-car",        readableBy: ["2.1+"] },
  { path: "_activity/",             class: "side-car",        readableBy: ["2.1+"] },
  { path: "feature-decisions.json", class: "side-car",        readableBy: ["2.1+"] },
];

const ACTIVE_STATUSES = new Set(["pending", "running", "paused"]);

function rollbackReadiness(runDir) {
  const runId = runDir.split("/").at(-1);
  const incompatibleArtifacts = [];

  for (const descriptor of ARTIFACT_REGISTRY) {
    if (descriptor.class !== "side-car") continue;
    if (descriptor.readableBy.includes(LEGACY_SCHEMA_VERSION)) continue;
    const fullPath = join(runDir, descriptor.path);
    if (existsSync(fullPath)) {
      incompatibleArtifacts.push(descriptor.path);
    }
  }

  return {
    runId,
    safe: incompatibleArtifacts.length === 0,
    incompatibleArtifacts,
    recommendation: "migrate-down",
  };
}

function readRunStatus(runDir) {
  const stateFile = join(runDir, "state.json");
  if (!existsSync(stateFile)) return null;
  try {
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.status === "string" ? parsed.status : null;
  } catch {
    return null;
  }
}

function listRunDirs(runsDir) {
  if (!existsSync(runsDir)) return [];
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(runsDir, d.name));
  } catch {
    return [];
  }
}

// --- Main ---

const runsDir =
  process.env["PI_ENGINEERING_RUNS_DIR"] ??
  join(homedir(), ".pi", "engineering-team", "runs");

const runDirs = listRunDirs(runsDir);

if (runDirs.length === 0) {
  console.log(`No runs found in ${runsDir}`);
  process.exit(0);
}

// Table header
const COL_ID   = 36;
const COL_ST   = 12;
const COL_SAFE = 8;
const COL_REC  = 24;

function pad(str, len) {
  return String(str).padEnd(len);
}

console.log(
  pad("Run ID", COL_ID) +
  pad("Status", COL_ST) +
  pad("Safe?", COL_SAFE) +
  pad("Recommendation", COL_REC),
);
console.log("-".repeat(COL_ID + COL_ST + COL_SAFE + COL_REC));

let anyUnsafeActive = false;

for (const runDir of runDirs) {
  const status = readRunStatus(runDir) ?? "unknown";
  const result = rollbackReadiness(runDir, LEGACY_SCHEMA_VERSION);
  const isActive = ACTIVE_STATUSES.has(status);

  let rec = result.recommendation;
  if (isActive && !result.safe) {
    rec = "finish or cancel";
    anyUnsafeActive = true;
  }

  const safeLabel = result.safe ? "YES" : "NO";

  console.log(
    pad(result.runId, COL_ID) +
    pad(status, COL_ST) +
    pad(safeLabel, COL_SAFE) +
    pad(rec, COL_REC),
  );

  if (!result.safe && result.incompatibleArtifacts.length > 0) {
    for (const artifact of result.incompatibleArtifacts) {
      console.log("  incompatible: " + artifact);
    }
  }
}

process.exit(anyUnsafeActive ? 1 : 0);
