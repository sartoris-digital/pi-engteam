#!/usr/bin/env node
// Writes process.env keys into the verdict issues array so env-scrub probes can
// see which parent variables survived buildWorkerEnv. Never prints values.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const verdict = process.env.PI_SDLC_VERDICT_FILE;
if (typeof verdict !== "string" || verdict.length === 0) {
  process.stderr.write("stub-pi-env: PI_SDLC_VERDICT_FILE missing\n");
  process.exit(4);
}
const payload = {
  step: process.env.PI_SDLC_STEP ?? "implement",
  verdict: "PASS",
  issues: Object.keys(process.env),
};
mkdirSync(dirname(verdict), { recursive: true });
const tmp = `${verdict}.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
renameSync(tmp, verdict);
process.exit(0);
