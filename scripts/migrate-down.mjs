#!/usr/bin/env node
// Pre-downgrade migrator for pi-engineering runs.
//
// Removes 2.1+ side-car files/dirs from one or all run directories,
// leaving state.json and events.jsonl byte-identical for 2.0.x.
//
// Usage:
//   PI_ENGINEERING_ROLLBACK_ACK=1 node scripts/migrate-down.mjs --runId <id>
//   PI_ENGINEERING_ROLLBACK_ACK=1 node scripts/migrate-down.mjs --all
//   PI_ENGINEERING_ROLLBACK_ACK=1 node scripts/migrate-down.mjs --all --dry-run
//
// Environment variables:
//   PI_ENGINEERING_RUNS_DIR       Override default runs directory
//   PI_ENGINEERING_ROLLBACK_ACK   Must be "1" to allow destructive removal

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Re-implement core logic inline — no dependency on compiled TS at runtime.
// Canonical source: src/team/schema-versioning.ts

const ARTIFACT_REGISTRY = [
  { path: "state.json",             class: "byte-compatible", readableBy: ["2.0.x", "2.1+"] },
  { path: "events.jsonl",           class: "byte-compatible", readableBy: ["2.0.x", "2.1+"] },
  { path: "state.v2.json",          class: "side-car",        readableBy: ["2.1+"] },
  { path: "_verdicts/",             class: "side-car",        readableBy: ["2.1+"] },
  { path: "_activity/",             class: "side-car",        readableBy: ["2.1+"] },
  { path: "feature-decisions.json", class: "side-car",        readableBy: ["2.1+"] },
];

function migrateDown(runDir, { dryRun = false } = {}) {
  const removed = [];
  const preserved = [];
  const errors = [];

  for (const descriptor of ARTIFACT_REGISTRY) {
    const fullPath = join(runDir, descriptor.path);
    if (!existsSync(fullPath)) continue;

    if (descriptor.class === "side-car") {
      if (!dryRun) {
        try {
          rmSync(fullPath, { recursive: true, force: true });
          removed.push(descriptor.path);
        } catch (err) {
          errors.push(
            `Failed to remove ${descriptor.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        removed.push(descriptor.path);
      }
    } else {
      preserved.push(descriptor.path);
    }
  }

  return { removed, preserved, errors };
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

// --- Argument parsing ---

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runId" && argv[i + 1]) {
      out.runId = argv[++i];
    } else if (a === "--all") {
      out.all = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.log(`Usage:
  PI_ENGINEERING_ROLLBACK_ACK=1 node scripts/migrate-down.mjs --runId <id>
  PI_ENGINEERING_ROLLBACK_ACK=1 node scripts/migrate-down.mjs --all
  PI_ENGINEERING_ROLLBACK_ACK=1 node scripts/migrate-down.mjs --all --dry-run

Removes 2.1+ side-car artifacts from run directories, making them
readable by pi-engineering 2.0.x.

Options:
  --runId <id>   Migrate a single run
  --all          Migrate all runs in the runs directory
  --dry-run      Print what would be removed without removing anything

Environment:
  PI_ENGINEERING_RUNS_DIR      Override default runs directory (~/.pi/engineering-team/runs)
  PI_ENGINEERING_ROLLBACK_ACK  Must be set to "1" to allow removal
`);
  process.exit(0);
}

// Safety gate
if (process.env["PI_ENGINEERING_ROLLBACK_ACK"] !== "1") {
  console.error(
    "Error: PI_ENGINEERING_ROLLBACK_ACK=1 must be set to confirm destructive side-car removal.",
  );
  console.error("Re-run with PI_ENGINEERING_ROLLBACK_ACK=1 to proceed.");
  process.exit(1);
}

if (!args.runId && !args.all) {
  console.error("Error: provide --runId <id> or --all.");
  process.exit(1);
}

const runsDir =
  process.env["PI_ENGINEERING_RUNS_DIR"] ??
  join(homedir(), ".pi", "engineering-team", "runs");

const dryRun = args.dryRun ?? false;

if (dryRun) {
  console.log("[dry-run] No files will be removed.\n");
}

// Resolve target run dirs
let targetDirs;
if (args.all) {
  targetDirs = listRunDirs(runsDir);
  if (targetDirs.length === 0) {
    console.log(`No runs found in ${runsDir}`);
    process.exit(0);
  }
} else {
  const runDir = join(runsDir, args.runId);
  if (!existsSync(runDir)) {
    console.error(`Error: run directory not found: ${runDir}`);
    process.exit(1);
  }
  targetDirs = [runDir];
}

let overallErrors = 0;

for (const runDir of targetDirs) {
  const runId = runDir.split("/").at(-1);
  const result = migrateDown(runDir, { dryRun });

  if (result.removed.length === 0 && result.errors.length === 0) {
    console.log(`${runId}: nothing to remove`);
    continue;
  }

  for (const path of result.removed) {
    const label = dryRun ? "[would remove]" : "removed";
    console.log(`${runId}: ${label} ${path}`);
  }

  for (const err of result.errors) {
    console.error(`${runId}: ERROR ${err}`);
    overallErrors++;
  }
}

process.exit(overallErrors > 0 ? 1 : 0);
