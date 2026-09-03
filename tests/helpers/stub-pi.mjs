#!/usr/bin/env node
// tests/helpers/stub-pi.mjs — scenario-driven fake `pi` for factory tests.
//
// Reads PI_SDLC_STUB_SCENARIO (path to JSON object keyed by stage). Each entry:
//   {
//     "verdict": "PASS"|"FAIL"|"NEEDS_MORE",   // required; no default
//     "files"?: { "<relpath>": "<content>" },  // under PI_SDLC_WORKSPACE_DIR
//     "runDirFiles"?: { "<relpath>": "<content>" },  // under $RUNS_DIR/$RUN_ID (D13)
//     "issues"?: string[],
//     "artifacts"?: string[],
//     "commit_message"?: string,
//     "sleepMs"?: number,
//     "noVerdict"?: boolean
//   }
// Unknown fields are rejected. `verdict` is validated before any writes.
// Relative paths must stay inside their root: no `..`, no absolute keys, no
// symlink escapes. PI_SDLC_VERDICT_FILE and PI_SDLC_STUB_LOG must resolve
// inside the workspace, the run dir, or the scenario file's directory.
//
// The prompt path is taken from argv: a token ending in `.prompt.md`
// (leading `@` stripped) or an absolute `*.prompt.md` path inside a longer token.
// All pi flags are ignored unless PI_SDLC_STUB_LOAD_EXTENSION=1 and argv contains
// `-e <entry>`: then the entry is loaded (jiti, same as Pi) into a fake ExtensionAPI,
// activate()/registerWorker installs Layers A–D, and a synthetic bash
// `git push origin HEAD` tool_call must block with terminate:true. Default scenario
// mode is unchanged when the env is unset. Never touches the network.
//
// Exit codes: 0 ok (also for noVerdict) · 2 no/unreadable prompt path · 3 no scenario
// entry for PI_SDLC_STEP · 4 missing env / unreadable or malformed scenario /
// invalid run id · 5 path containment violation · 6 extension load / guard probe.
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const VERDICTS = new Set(["PASS", "FAIL", "NEEDS_MORE"]);
const ENTRY_FIELDS = new Set([
  "verdict",
  "files",
  "runDirFiles",
  "issues",
  "artifacts",
  "commit_message",
  "sleepMs",
  "noVerdict",
]);
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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

function isInside(root, p) {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertSafeRel(rel, label) {
  if (typeof rel !== "string" || rel === "") fail(5, `${label} must be a non-empty relative path`);
  if (isAbsolute(rel)) fail(5, `${label} must be relative, not absolute: ${rel}`);
  const parts = rel.split(/[/\\]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(5, `${label} rejects empty, '.', and '..' segments: ${rel}`);
  }
}

function realizeExisting(absPath) {
  let current = resolve(absPath);
  const missing = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(absPath);
      missing.unshift(current.slice(parent.length + 1) || current.slice(parent.length));
      current = parent;
    }
  }
}

function resolveUnder(root, rel, label) {
  assertSafeRel(rel, label);
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch (err) {
    fail(5, `${label} root unreadable (${root}): ${err.message}`);
  }
  const parts = rel.split(/[/\\]/);
  let current = rootReal;
  for (let i = 0; i < parts.length; i++) {
    const next = join(current, parts[i]);
    let st;
    try {
      st = lstatSync(next);
    } catch {
      const rest = join(current, ...parts.slice(i));
      if (!isInside(rootReal, rest)) fail(5, `${label} escapes ${root}: ${rel}`);
      return rest;
    }
    if (st.isSymbolicLink()) {
      let real;
      try {
        real = realpathSync(next);
      } catch (err) {
        fail(5, `${label} dangling symlink: ${rel} (${err.message})`);
      }
      if (!(real === rootReal || isInside(rootReal, real))) {
        fail(5, `${label} symlink escapes ${root}: ${rel}`);
      }
      current = real;
    } else {
      current = next;
    }
  }
  if (!(current === rootReal || isInside(rootReal, current))) {
    fail(5, `${label} escapes ${root}: ${rel}`);
  }
  return current;
}

function assertDestInside(absPath, roots, label) {
  if (typeof absPath !== "string" || absPath.trim() === "") fail(4, `${label} missing`);
  const realized = realizeExisting(absPath);
  for (const root of roots) {
    if (!root) continue;
    try {
      const rootReal = realpathSync(root);
      if (isInside(rootReal, realized)) return resolve(absPath);
    } catch {
      // skip unreadable allowed roots
    }
  }
  fail(5, `${label} must be under the workspace, run dir, or scenario dir: ${absPath}`);
}

function stringMap(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(4, `${label} must be an object of relative path → string`);
  }
  const out = {};
  for (const [rel, content] of Object.entries(value)) {
    if (typeof content !== "string") fail(4, `${label}[${JSON.stringify(rel)}] must be a string`);
    out[rel] = content;
  }
  return out;
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
if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
  fail(4, "scenario must be a JSON object keyed by stage");
}

const promptPath = findPromptPath(argv);
if (!promptPath) fail(2, `no *.prompt.md path in argv ${JSON.stringify(argv)}`);
let promptFirstLine = "";
try {
  promptFirstLine = readFileSync(promptPath, "utf8").split("\n")[0] ?? "";
} catch (err) {
  fail(2, `cannot read prompt ${promptPath}: ${err.message}`);
}

const entry = scenario[step];
if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
  fail(3, `no scenario entry for step ${JSON.stringify(step)} (scenario has: ${Object.keys(scenario).join(", ") || "none"})`);
}

for (const key of Object.keys(entry)) {
  if (!ENTRY_FIELDS.has(key)) fail(4, `unknown scenario field ${JSON.stringify(key)}`);
}

if (!VERDICTS.has(entry.verdict)) {
  fail(4, `invalid verdict ${JSON.stringify(entry.verdict)} (expected PASS|FAIL|NEEDS_MORE)`);
}
if (entry.issues !== undefined && !Array.isArray(entry.issues)) fail(4, "issues must be an array");
if (entry.artifacts !== undefined && !Array.isArray(entry.artifacts)) fail(4, "artifacts must be an array");
if (entry.commit_message !== undefined && typeof entry.commit_message !== "string") {
  fail(4, "commit_message must be a string");
}
if (entry.noVerdict !== undefined && typeof entry.noVerdict !== "boolean") fail(4, "noVerdict must be a boolean");
const sleepMs = entry.sleepMs ?? 0;
if (typeof sleepMs !== "number" || !Number.isFinite(sleepMs) || sleepMs < 0) {
  fail(4, "sleepMs must be a finite number >= 0");
}

const workspace = env.PI_SDLC_WORKSPACE_DIR;
if (!workspace) fail(4, "PI_SDLC_WORKSPACE_DIR not set");
let workspaceReal;
try {
  workspaceReal = realpathSync(workspace);
  if (!lstatSync(workspaceReal).isDirectory()) fail(4, "PI_SDLC_WORKSPACE_DIR is not a directory");
} catch (err) {
  fail(4, `PI_SDLC_WORKSPACE_DIR unreadable: ${err.message}`);
}

const runId = env.PI_SDLC_RUN_ID ?? "";
const runsDir = env.PI_SDLC_RUNS_DIR ?? "";
if (!runId || !RUN_ID_RE.test(runId)) {
  fail(4, `invalid PI_SDLC_RUN_ID ${JSON.stringify(runId)}`);
}
if (!runsDir) fail(4, "PI_SDLC_RUNS_DIR not set");
const runDir = join(runsDir, runId);
mkdirSync(runDir, { recursive: true });
let runDirReal;
try {
  runDirReal = realpathSync(runDir);
} catch (err) {
  fail(4, `run dir unreadable: ${err.message}`);
}

let scenarioDir;
try {
  scenarioDir = dirname(realpathSync(scenarioPath));
} catch {
  scenarioDir = dirname(resolve(scenarioPath));
}

const allowedDestRoots = [workspaceReal, runDirReal, scenarioDir];
const files = stringMap(entry.files, "files");
const runDirFiles = stringMap(entry.runDirFiles, "runDirFiles");

const fileWrites = [];
for (const [rel, content] of Object.entries(files)) {
  fileWrites.push({ abs: resolveUnder(workspaceReal, rel, "files"), content });
}
const runDirWrites = [];
for (const [rel, content] of Object.entries(runDirFiles)) {
  runDirWrites.push({ abs: resolveUnder(runDirReal, rel, "runDirFiles"), content });
}

const logPath = env.PI_SDLC_STUB_LOG
  ? assertDestInside(env.PI_SDLC_STUB_LOG, allowedDestRoots, "PI_SDLC_STUB_LOG")
  : null;
const verdictFile = entry.noVerdict === true
  ? null
  : (() => {
      const path = env.PI_SDLC_VERDICT_FILE;
      if (!path) fail(4, "PI_SDLC_VERDICT_FILE not set");
      return assertDestInside(path, allowedDestRoots, "PI_SDLC_VERDICT_FILE");
    })();

if (logPath) {
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
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
}

for (const { abs, content } of fileWrites) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}
for (const { abs, content } of runDirWrites) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

if (env.PI_SDLC_STUB_LOAD_EXTENSION === "1") {
  const { findExtensionEntry, loadAndActivate, fireToolCall, assertGitPushTerminated } = await import(
    new URL("./load-extension.mjs", import.meta.url)
  );
  const entry = findExtensionEntry(argv);
  if (entry) {
    let pi;
    try {
      pi = await loadAndActivate(entry, env);
    } catch (err) {
      fail(6, `cannot load extension ${entry}: ${err.message}`);
    }
    let result;
    try {
      result = await fireToolCall(pi, "bash", { command: "git push origin HEAD" });
      assertGitPushTerminated(result);
    } catch (err) {
      fail(6, err.message);
    }
    const record = {
      kind: "guard",
      at: new Date().toISOString(),
      toolName: "bash",
      command: "git push origin HEAD",
      result,
    };
    if (logPath) appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
    process.stderr.write(`stub-pi: guard ${JSON.stringify(result)}\n`);
  }
}

if (sleepMs > 0) await new Promise((resolveSleep) => setTimeout(resolveSleep, sleepMs));

if (entry.noVerdict === true || verdictFile === null) process.exit(0);

const payload = {
  step,
  verdict: entry.verdict,
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
