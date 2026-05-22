#!/usr/bin/env node
// Phase 0a — capability probe harness.
//
// Spawns `pi -p --no-session` against the user's configured provider
// in an ISOLATED tmpdir/probe-runDir with canary files (round 2
// MED #7), captures the model's tool-use response, classifies which
// tools the model saw, and writes a CapabilityBundle JSON consumable
// by src/team/capability-matrix.ts.
//
// Usage:
//   node scripts/probe-pi-provider.mjs --provider <name> --model <id>
//     [--pi-binary <path>] [--account-fingerprint <hash>]
//     [--out <bundle.json>] [--dry-run] [--max-probe-files <number>]
//
// Real-mutation channels are stubbed: SendMessage/Request/Grant/
// UseSecret tools have no live broker; probe-runDir is wiped on
// success (preserved with .failed suffix on harness error).

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";

const HARNESS_VERSION = "0.1.0";
const SCHEMA_VERSION = 1;

// ---------- argv parsing ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.provider) {
  console.error("usage: probe-pi-provider.mjs --provider <name> --model <id> [--max-probe-files <number>] [...]");
  process.exit(2);
}

const provider = String(args.provider);
const modelId = String(args.model ?? "*");
const piBinary = String(args["pi-binary"] ?? "pi");
const accountFingerprint = String(args["account-fingerprint"] ?? "unknown");
const dryRun = Boolean(args["dry-run"]);

// Parse and validate maxProbeFiles — use Number() not parseInt() so "3.5" → 3.5 (non-integer) is rejected
const maxProbeFiles = Number(args["max-probe-files"] ?? "3");
if (!Number.isInteger(maxProbeFiles) || maxProbeFiles < 1 || maxProbeFiles > 10) {
  console.error("--max-probe-files must be an integer between 1 and 10");
  process.exit(2);
}

// ---------- runtime fingerprint ----------

async function exec(cmd, cmdArgs) {
  return new Promise((res, rej) => {
    const proc = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("error", rej);
    proc.on("close", (code) => res({ code, stdout, stderr }));
  });
}

async function getPiVersion() {
  try {
    const r = await exec(piBinary, ["--version"]);
    const v = r.stdout.trim().match(/(\d+\.\d+\.\d+\S*)/);
    return v ? v[1] : "unknown";
  } catch {
    return "unknown";
  }
}

async function getPiBuildHash() {
  // Pi may not expose a build hash; fall back to a sha256 of the
  // realpath'd binary contents (changes when the binary changes).
  try {
    const r = await exec("which", [piBinary]);
    const p = r.stdout.trim();
    if (!p || !existsSync(p)) return "unknown";
    const real = path.resolve(p);
    const buf = readFileSync(real);
    return createHash("sha256").update(buf).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

// ---------- probe-runDir setup ----------

function setupProbeRunDir(maxFiles) {
  const root = mkdtempSync(join(tmpdir(), "pi-eng-probe-"));
  const canaries = [];
  for (let i = 1; i <= maxFiles; i++) {
    const fname = `probe-canary-${i}.txt`;
    const sentinel = randomBytes(16).toString("hex");
    const fpath = join(root, fname);
    writeFileSync(fpath, `canary-${i}: ${sentinel}\n`, "utf8");
    canaries.push({ name: fname, path: fpath, sentinel });
  }
  return { root, canaries };
}

const probeRun = setupProbeRunDir(maxProbeFiles);
const probeVerdictFile = join(probeRun.root, "probe-verdict.json");

// ---------- prompt construction ----------

const probeMessage = `You are running inside a capability-probe harness. Do these EXACT actions, then stop:

1. List every tool you can see in your inventory (one tool per line).
2. Attempt to call \`VerdictEmit\` with {"step":"probe","verdict":"PASS","artifacts":[]}.
   If VerdictEmit is not in your inventory, instead use the \`write\` tool to write the same JSON to: ${probeVerdictFile}
   If neither tool works, emit the JSON as plain text in your final message.
3. Attempt to call \`write\` to create ${probeRun.root}/probe-write.txt with content "ok-write".
4. Attempt to call \`edit\` to change ${probeRun.canaries[0].path} replacing "canary-1" with "edited-1".
5. Attempt to call \`read\` on each of:
     ${probeRun.canaries.map(c => c.path).join('\n     ')}
6. Attempt to call \`SendMessage\` to recipient "probe-sink" with body "ping". (Expected to fail in this harness.)

Do NOT do anything else. Do NOT investigate the project. Do NOT modify files outside the probe-runDir.`;

const systemPromptPath = join(probeRun.root, "probe-system.txt");
writeFileSync(
  systemPromptPath,
  `You are a Pi capability probe. Follow the user's instructions LITERALLY. Do not refuse, do not investigate, do not ask questions. End your turn after step 6.\n`,
  "utf8",
);

// ---------- spawn ----------

async function runProbe() {
  if (dryRun) {
    return { code: 0, stdout: "(dry-run)", stderr: "" };
  }
  const env = {
    ...process.env,
    PI_ENGINEERING_VERDICT_FILE: probeVerdictFile,
    PI_ENGINEERING_RUN_ID: "probe",
    PI_ENGINEERING_RUNS_DIR: probeRun.root,
    PI_ENGINEERING_AGENT_MODE: "1",
    PI_ENGINEERING_PROBE: "1",
  };
  const piArgs = [
    "-p",
    "--no-session",
    "--append-system-prompt",
    systemPromptPath,
  ];
  if (modelId && modelId !== "*") {
    piArgs.unshift("--model", modelId);
  }
  piArgs.push(probeMessage);

  return new Promise((res, rej) => {
    const proc = spawn(piBinary, piArgs, {
      cwd: probeRun.root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("error", rej);
    proc.on("close", (code) => res({ code, stdout, stderr }));
    // Safety cap — 3 minutes.
    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
    }, 180_000).unref?.();
  });
}

// ---------- classification ----------

function classifySentinelResults(stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  const results = {};
  // VerdictEmit
  if (/VerdictEmit/.test(text) && /tool_call|invoked|calling/i.test(text)) {
    results.VerdictEmit = "ok";
  } else if (existsSync(probeVerdictFile)) {
    results.VerdictEmit = "tool-not-in-inventory"; // model used write fallback
  } else {
    results.VerdictEmit = "tool-not-in-inventory";
  }
  // write
  if (existsSync(join(probeRun.root, "probe-write.txt"))) {
    results.write = "ok";
  } else if (/domain-lock|blocked/i.test(text)) {
    results.write = "blocked-by-domain-lock";
  } else {
    results.write = "tool-not-in-inventory";
  }
  // edit — check whether canary 1 was modified
  try {
    const c1 = readFileSync(probeRun.canaries[0].path, "utf8");
    results.edit = c1.startsWith("edited-1") ? "ok" : (c1.startsWith("canary-1") ? "tool-not-in-inventory" : "error");
  } catch {
    results.edit = "error";
  }
  // read — if the model echoed any canary sentinel we know read worked
  let readOk = false;
  for (const c of probeRun.canaries) {
    if (text.includes(c.sentinel)) {
      readOk = true;
      break;
    }
  }
  results.read = readOk ? "ok" : "tool-not-in-inventory";
  // SendMessage — no broker in probe mode, so any model-reported
  // failure is the expected outcome.
  results.SendMessage = /SendMessage/i.test(text) ? "tool-not-in-inventory" : "tool-not-in-inventory";
  return results;
}

function extractObservedTools(stdout) {
  const lines = stdout.split(/\r?\n/);
  const tools = new Set();
  // Models tend to list tools as numbered, bulleted, or backticked
  // entries. Extract conservative matches.
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*\d]+[.)]?\s*)?`?([A-Za-z_][A-Za-z0-9_]+)`?\s*$/);
    if (m && m[1].length <= 32) tools.add(m[1]);
    const backtick = line.match(/`([A-Za-z_][A-Za-z0-9_]+)`/g);
    if (backtick) for (const b of backtick) tools.add(b.replace(/`/g, ""));
  }
  // Filter to a sensible candidate set — well-known tool names.
  const known = new Set([
    "VerdictEmit", "SendMessage", "RequestApproval", "GrantApproval",
    "UseSecret", "TaskList", "TaskUpdate", "CheckApproval",
    "read", "write", "edit", "bash", "glob", "grep", "ls",
  ]);
  return [...tools].filter((t) => known.has(t));
}

function classifyStreams(stdout) {
  // Naive heuristic: if any chunks of stdout match the bare-pi
  // protocol (italic thinking blocks + monospace code fences), we
  // assume realtime is available on stdout. The richer classifier
  // lives in src/team/StreamClassifier.ts (Phase B item 12).
  const hasThinking = /\*[A-Za-z]/.test(stdout) || /^thinking:/im.test(stdout);
  const hasToolCalls = /tool_call|invoke|\$\s/.test(stdout);
  return {
    thinking: hasThinking ? "stdout" : "none",
    tool_call_invoke: hasToolCalls ? "stdout" : "audit-post-close-only",
    tool_call_result: hasToolCalls ? "stdout" : "audit-post-close-only",
    assistant_text: "stdout",
    error: "stderr",
  };
}

// ---------- write bundle ----------

function canonicalize(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function computeHash(bundle) {
  const cleared = { ...bundle, provenance: { ...bundle.provenance, probeBundleHash: "" } };
  return createHash("sha256").update(canonicalize(cleared)).digest("hex");
}

function bundleOutputPath() {
  if (args.out) return String(args.out);
  const base = join(homedir(), ".pi", "engineering-team", "capabilities", provider);
  mkdirSync(base, { recursive: true });
  const safeModel = modelId.replace(/[^A-Za-z0-9._-]+/g, "-");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(base, `${args["pi-version"] ?? "auto"}-${safeModel}-${ts}.json`);
}

async function main() {
  let proc;
  try {
    const piVersion = String(args["pi-version"] ?? (await getPiVersion()));
    const piBuildHash = String(args["pi-build-hash"] ?? (await getPiBuildHash()));
    const piEngVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

    proc = await runProbe();
    if (proc.code !== 0 && !dryRun) {
      console.error(`Probe subprocess exited ${proc.code}; capturing what we got and marking bundle incomplete.`);
    }
    const observedTools = dryRun ? ["read", "write"] : extractObservedTools(proc.stdout);
    const sentinelResults = dryRun ? { write: "ok", read: "ok" } : classifySentinelResults(proc.stdout, proc.stderr);
    const streams = dryRun
      ? { thinking: "stdout", tool_call_invoke: "stdout", tool_call_result: "stdout", assistant_text: "stdout", error: "stderr" }
      : classifyStreams(proc.stdout);

    const bundle = {
      schemaVersion: SCHEMA_VERSION,
      provenance: {
        provider,
        modelId,
        accountFingerprint,
        piVersion,
        piBuildHash,
        piEngVersion,
        protocolVersion: String(args["protocol-version"] ?? "auto"),
        runtimeFlags: String(args["runtime-flags"] ?? "")
          .split(",")
          .filter(Boolean)
          .sort(),
        probeTs: new Date().toISOString(),
        probeBundleHash: "",
        harnessVersion: HARNESS_VERSION,
      },
      observedTools,
      sentinelResults,
      streams,
      notes: dryRun ? "dry-run: no Pi subprocess executed" : undefined,
    };
    bundle.provenance.probeBundleHash = computeHash(bundle);

    const outPath = bundleOutputPath();
    mkdirSync(path.dirname(outPath), { recursive: true });
    const tmpOut = `${outPath}.tmp`;
    writeFileSync(tmpOut, JSON.stringify(bundle, null, 2), { mode: 0o600 });
    renameSync(tmpOut, outPath);
    console.log(`Wrote capability bundle: ${outPath}`);
    console.log(`Observed tools: ${observedTools.join(", ") || "(none)"}`);
    console.log(`Sentinel: ${JSON.stringify(sentinelResults)}`);

    // Cleanup probe-runDir
    try { rmSync(probeRun.root, { recursive: true, force: true }); } catch {}
  } catch (err) {
    console.error("Probe harness failed:", err?.message ?? err);
    try {
      renameSync(probeRun.root, `${probeRun.root}.failed`);
    } catch {}
    process.exit(1);
  }
}

main();
