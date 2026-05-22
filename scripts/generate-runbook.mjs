#!/usr/bin/env node
// Phase E item E1 — regenerate docs/runbooks/observability.md from
// the metric catalog. Run via `pnpm runbook`. CI verifies the
// on-disk file matches the freshly-generated output.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateRunbook } from "../dist/observability/runbook-generator.js";

const target = join(process.cwd(), "docs", "runbooks", "observability.md");
mkdirSync(dirname(target), { recursive: true });
const next = generateRunbook();

const check = process.argv.includes("--check");
if (check) {
  if (!existsSync(target)) {
    console.error(`[runbook] target file does not exist: ${target}`);
    process.exit(2);
  }
  const current = readFileSync(target, "utf8");
  if (current === next) {
    console.log("[runbook] up-to-date");
    process.exit(0);
  }
  console.error("[runbook] DIFF detected — regenerate with `pnpm runbook`.");
  process.exit(1);
}

writeFileSync(target, next, "utf8");
console.log(`[runbook] wrote ${target}`);
