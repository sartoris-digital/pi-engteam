#!/usr/bin/env node
// Phase B items 15 + 17 — CLI tail + replay for the activity stream.
//
// Usage:
//   pi-engineering-tail <runId>             # live tail
//   pi-engineering-tail <runId> --replay    # print whole file + exit
//   pi-engineering-tail <runId> --runs-dir <path>  # override runsDir
//   pi-engineering-tail <runId> --no-color  # plain output
//
// Reads `<runsDir>/_activity/<runId>/agent-activity.jsonl`. Falls
// back to the legacy mirror at `<runsDir>/<runId>/agent-activity.jsonl`
// when the canonical file is absent — useful when an old (2.0.x)
// run dir is being inspected by a newer CLI.

import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArgs(argv) {
  const out = { _: [], color: process.stdout.isTTY };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--replay") out.replay = true;
    else if (a === "--no-color") out.color = false;
    else if (a === "--runs-dir" && argv[i + 1]) { out.runsDir = argv[++i]; }
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help || args._.length === 0) {
  console.error("usage: pi-engineering-tail <runId> [--replay] [--runs-dir <path>] [--no-color]");
  process.exit(args.help ? 0 : 2);
}

const runId = args._[0];
const runsDir = args.runsDir ?? join(homedir(), ".pi", "engineering-team", "runs");
const canonical = join(runsDir, "_activity", runId, "agent-activity.jsonl");
const legacy = join(runsDir, runId, "agent-activity.jsonl");

const filePath = existsSync(canonical) ? canonical : legacy;
if (!existsSync(filePath)) {
  console.error(`No activity file found for run ${runId}.`);
  console.error(`Looked at:`);
  console.error(`  ${canonical}`);
  console.error(`  ${legacy}`);
  process.exit(1);
}

// ANSI color helpers
const C = args.color ? {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} : {
  reset: "", dim: "", bold: "", italic: "",
  red: "", green: "", yellow: "", blue: "", magenta: "", cyan: "", gray: "",
};

function formatEvent(ev) {
  const ts = (ev.sourceTs ?? "").slice(11, 19); // HH:MM:SS
  const agent = ev.agentName ?? "?";
  const step = ev.step ?? "?";
  const kind = ev.kind ?? "?";
  const seq = ev.seq ?? "";

  const prefix = `${C.gray}${ts}${C.reset} ${C.cyan}#${seq}${C.reset} [${C.bold}${agent}${C.reset}·${step}·${kindColor(kind)}${kind}${C.reset}]`;

  let body = ev.body ?? "";
  switch (kind) {
    case "thinking":
      body = `${C.italic}${C.gray}${body}${C.reset}`;
      break;
    case "tool_call_invoke":
      body = `${C.bold}${body}${C.reset}`;
      break;
    case "tool_call_result":
      body = `${C.dim}${body}${C.reset}`;
      break;
    case "error":
      body = `${C.red}${body}${C.reset}`;
      break;
    case "verdict":
      body = `${C.green}${body}${C.reset}`;
      break;
    case "stuck-warning":
      body = `${C.yellow}${body}${C.reset}`;
      break;
    case "heartbeat":
      body = `${C.dim}${body}${C.reset}`;
      break;
    case "essential-coalesced":
      body = `${C.magenta}${body}${C.reset}`;
      break;
  }
  return `${prefix} ${body}`;
}

function kindColor(kind) {
  switch (kind) {
    case "thinking": return C.gray;
    case "tool_call_invoke": return C.bold;
    case "tool_call_result": return C.dim;
    case "error": return C.red;
    case "verdict": return C.green;
    case "stuck-warning": return C.yellow;
    case "heartbeat": return C.dim;
    case "essential-coalesced": return C.magenta;
    default: return "";
  }
}

function printLine(line) {
  if (!line.trim()) return;
  try {
    const ev = JSON.parse(line);
    process.stdout.write(formatEvent(ev) + "\n");
  } catch {
    // Malformed line — print raw so the operator can spot it.
    process.stdout.write(`${C.red}[malformed JSONL line]${C.reset} ${line}\n`);
  }
}

async function replay() {
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) printLine(line);
}

async function tail() {
  let pos = 0;
  let partial = "";
  // Replay history first so operators see what came before they
  // attached.
  if (existsSync(filePath)) {
    const text = readFileSync(filePath, "utf8");
    pos = Buffer.byteLength(text, "utf8");
    for (const line of text.split("\n")) printLine(line);
  }

  const readNew = async () => {
    try {
      const st = statSync(filePath);
      if (st.size <= pos) return;
      const fh = await open(filePath, "r");
      try {
        const buf = Buffer.alloc(st.size - pos);
        await fh.read(buf, 0, buf.length, pos);
        pos = st.size;
        const text = partial + buf.toString("utf8");
        const lines = text.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) printLine(line);
      } finally {
        await fh.close();
      }
    } catch (err) {
      // file rotated / removed; bail quietly
    }
  };

  // Both fs.watch and a periodic poll — watch may miss events on
  // some platforms (NFS, macOS APFS occasionally), so poll as a
  // belt-and-suspenders signal.
  watch(filePath, { persistent: true }, () => { void readNew(); });
  setInterval(readNew, 500).unref?.();

  // Keep the process alive
  process.stdin.resume?.();
}

if (args.replay) {
  await replay();
} else {
  await tail();
}
