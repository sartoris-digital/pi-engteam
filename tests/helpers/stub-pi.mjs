#!/usr/bin/env node
// tests/helpers/stub-pi.mjs — scenario-driven fake `pi` for factory tests.
//
// Reads PI_SDLC_STUB_SCENARIO (path to JSON: { "<stage>": { verdict, files?, runDirFiles?,
// issues?, commit_message?, sleepMs?, noVerdict? } }), picks the entry for PI_SDLC_STEP,
// writes `files` under PI_SDLC_WORKSPACE_DIR, `runDirFiles` under
// <PI_SDLC_RUNS_DIR>/<PI_SDLC_RUN_ID>, and the verdict JSON to PI_SDLC_VERDICT_FILE
// (tmp + rename). The prompt path is taken from argv: a token ending in `.prompt.md`
// (leading `@` stripped) or an absolute `*.prompt.md` path inside a longer token.
// All pi flags are ignored. Never loads the extension, never touches the network.
//
// Exit codes: 0 ok (also for noVerdict) · 2 no/unreadable prompt path · 3 no scenario
// entry for PI_SDLC_STEP · 4 PI_SDLC_STUB_SCENARIO / PI_SDLC_VERDICT_FILE missing, or
// runDirFiles without PI_SDLC_RUNS_DIR / PI_SDLC_RUN_ID.
// Optional PI_SDLC_STUB_LOG=<path> appends one JSON line per invocation.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function fail(code, message) {
  process.stderr.write(`stub-pi: ${message}\n`);
  process.exit(code);
}

function findPromptPath(argv) {
  for (const raw of argv) {
    const token = raw.startsWith("@") ? raw.slice(1) : raw;
    if (token.endsWith(".prompt.md")) return token;
    const embedded = /(\/[^\s"'`]+\.prompt\.md)/.exec(token);
    if (embedded) return embedded[1];
  }
  return null;
}

const argv = process.argv.slice(2);
const env = process.env;
const step = env.PI_SDLC_STEP ?? "";

const scenarioPath = env.PI_SDLC_STUB_SCENARIO;
if (!scenarioPath) fail(4, "PI_SDLC_STUB_SCENARIO not set");
let scenario;
try {
  scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
} catch (err) {
  fail(4, `cannot read scenario ${scenarioPath}: ${err.message}`);
}

const promptPath = findPromptPath(argv);
if (!promptPath) fail(2, `no *.prompt.md path in argv ${JSON.stringify(argv)}`);
let promptFirstLine = "";
try {
  promptFirstLine = readFileSync(promptPath, "utf8").split("\n")[0] ?? "";
} catch (err) {
  fail(2, `cannot read prompt ${promptPath}: ${err.message}`);
}

if (env.PI_SDLC_STUB_LOG) {
  const record = {
    at: new Date().toISOString(),
    pid: process.pid,
    cwd: process.cwd(),
    argv,
    promptPath,
    promptFirstLine,
    step,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("PI_SDLC_"))),
  };
  mkdirSync(dirname(env.PI_SDLC_STUB_LOG), { recursive: true });
  appendFileSync(env.PI_SDLC_STUB_LOG, JSON.stringify(record) + "\n", "utf8");
}

const entry = scenario[step];
if (!entry || typeof entry !== "object") {
  fail(3, `no scenario entry for step ${JSON.stringify(step)} (scenario has: ${Object.keys(scenario).join(", ") || "none"})`);
}

const workspace = env.PI_SDLC_WORKSPACE_DIR || process.cwd();
const files = entry.files && typeof entry.files === "object" ? entry.files : {};
for (const [rel, content] of Object.entries(files)) {
  const abs = join(workspace, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, String(content), "utf8");
}

const runDirFiles = entry.runDirFiles && typeof entry.runDirFiles === "object" ? entry.runDirFiles : {};
if (Object.keys(runDirFiles).length > 0) {
  if (!env.PI_SDLC_RUNS_DIR || !env.PI_SDLC_RUN_ID) {
    fail(4, "runDirFiles needs PI_SDLC_RUNS_DIR and PI_SDLC_RUN_ID");
  }
  const runDir = join(env.PI_SDLC_RUNS_DIR, env.PI_SDLC_RUN_ID);
  for (const [rel, content] of Object.entries(runDirFiles)) {
    const abs = join(runDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, String(content), "utf8");
  }
}

const sleepMs = Number(entry.sleepMs ?? 0);
if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));

if (entry.noVerdict === true) process.exit(0);

const verdictFile = env.PI_SDLC_VERDICT_FILE;
if (!verdictFile) fail(4, "PI_SDLC_VERDICT_FILE not set");

const payload = {
  step,
  verdict: entry.verdict ?? "PASS",
  issues: Array.isArray(entry.issues) ? entry.issues : [],
  artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
  changedFiles: Object.keys(files),
  ...(typeof entry.commit_message === "string" ? { commit_message: entry.commit_message } : {}),
};
mkdirSync(dirname(verdictFile), { recursive: true });
const tmp = `${verdictFile}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(payload) + "\n", "utf8");
renameSync(tmp, verdictFile);
process.exit(0);
