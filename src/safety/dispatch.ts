import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { generatedMarker } from "../runtime/marker.js";
import { pendingApprovalPath, type PendingApproval } from "../worker/request-approval.js";
import { nestedShellCommands, splitSegments, stripAssignments, tokenize, unquote, unsupportedShellConstruct } from "./shell.js";
import { hashArgs, mintToken } from "./tokens.js";

export type DispatchDecision = { grant: true; op: string; argsHash: string } | { grant: false; reason: string };
export type DispatchCallback = (pending: PendingApproval) => Promise<DispatchDecision>;

export interface DispatchOnceResult {
  processed: string[];
  granted: string[];
  denied: string[];
  skipped: string[];
}

export interface RegisterApprovalDispatcherOpts {
  runDir: string;
  secret: string;
  callback: DispatchCallback;
  pollMs?: number;
  now?: () => Date;
}

const LOCAL_VERBS = new Set(["rm", "rmdir", "mv", "chmod"]);
const GIT_LOCAL_SUB = new Set(["stash"]);
const TOKEN_TTL_SECONDS = 300;

function verbName(raw: string): string {
  const cleaned = unquote(raw).replace(/\\/g, "/");
  const base = basename(cleaned);
  return (base.length > 0 ? base : cleaned).toLowerCase();
}

function gitSubcommand(cmd: readonly string[]): string | undefined {
  const words = cmd.map(unquote);
  let i = 1;
  while (i < words.length) {
    const w = words[i] as string;
    if (w === "-C" || w === "-c") {
      i += 2;
      continue;
    }
    if (w.startsWith("--git-dir") || w.startsWith("--work-tree") || w.startsWith("--namespace")) {
      i += w.includes("=") ? 1 : 2;
      continue;
    }
    if (w.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  return words[i];
}

function gitLeavesWorktree(cmd: readonly string[]): boolean {
  const words = cmd.map(unquote);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "-C" || w === "--git-dir" || w === "--work-tree") return true;
    if (w.startsWith("--git-dir=") || w.startsWith("--work-tree=")) return true;
  }
  return false;
}

function segmentIsLocalDestructive(segment: string): boolean {
  if (segment.includes("://")) return false;
  const { words } = tokenize(segment);
  const cmd = stripAssignments(words);
  const verb = verbName(cmd[0] ?? "");
  if (!verb) return false;
  const nested = nestedShellCommands(cmd);
  if (nested.length > 0) return nested.every((inner) => localDestructiveOnly(inner));
  if (LOCAL_VERBS.has(verb)) return true;
  if (verb === "git") {
    if (gitLeavesWorktree(cmd)) return false;
    const sub = gitSubcommand(cmd);
    return sub !== undefined && GIT_LOCAL_SUB.has(sub);
  }
  return false;
}

/** True only for Layer-C local-destructive ops that cannot reach the network or a tracker. */
export function localDestructiveOnly(command: string): boolean {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (command.includes("://")) return false;
  if (unsupportedShellConstruct(command) !== null) return false;
  const segments = splitSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => segmentIsLocalDestructive(segment));
}

function bashArgsHash(command: string): string {
  return hashArgs("bash", { command });
}

async function listPending(runDir: string): Promise<string[]> {
  try {
    return (await readdir(join(runDir, "approvals", "pending"))).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function loadPending(runDir: string, requestId: string): Promise<PendingApproval> {
  const raw = JSON.parse(await readFile(pendingApprovalPath(runDir, requestId), "utf8")) as PendingApproval;
  return raw;
}

async function writeDenied(runDir: string, pending: PendingApproval, reason: string, now: Date): Promise<void> {
  const dir = join(runDir, "approvals", "denied");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body = {
    _marker: generatedMarker(pending.runId),
    requestId: pending.requestId,
    runId: pending.runId,
    op: pending.op,
    command: pending.command,
    reason,
    deniedAt: now.toISOString(),
  };
  await writeFile(join(dir, `${pending.requestId}.json`), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

async function consumePending(runDir: string, requestId: string): Promise<void> {
  const src = pendingApprovalPath(runDir, requestId);
  try {
    await unlink(src);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function mintFromPending(runDir: string, secret: string, pending: PendingApproval, now: () => Date): void {
  mintToken(runDir, secret, {
    op: "bash",
    argsHash: bashArgsHash(pending.command),
    ttlSeconds: TOKEN_TTL_SECONDS,
    now,
    runId: pending.runId,
  });
}

export async function dispatchOnce(opts: {
  runDir: string;
  secret: string;
  callback: DispatchCallback;
  now?: () => Date;
  seen?: Set<string>;
}): Promise<DispatchOnceResult> {
  const now = opts.now ?? (() => new Date());
  const seen = opts.seen ?? new Set<string>();
  const result: DispatchOnceResult = { processed: [], granted: [], denied: [], skipped: [] };
  const names = await listPending(opts.runDir);
  for (const name of names) {
    const requestId = name.slice(0, -".json".length);
    if (requestId.length === 0 || seen.has(requestId)) continue;
    result.processed.push(requestId);
    let pending: PendingApproval;
    try {
      pending = await loadPending(opts.runDir, requestId);
    } catch {
      continue;
    }
    let decision: DispatchDecision;
    try {
      decision = await opts.callback(pending);
    } catch {
      // Fail-closed: do not mint; leave pending for `/factory grant`.
      continue;
    }
    if (decision.grant === false) {
      await writeDenied(opts.runDir, pending, decision.reason, now());
      await consumePending(opts.runDir, requestId);
      seen.add(requestId);
      result.denied.push(requestId);
      continue;
    }
    if (!localDestructiveOnly(pending.command)) {
      seen.add(requestId);
      result.skipped.push(requestId);
      continue;
    }
    const expected = bashArgsHash(pending.command);
    if (decision.argsHash !== expected) {
      await writeDenied(opts.runDir, pending, "argsHash mismatch", now());
      await consumePending(opts.runDir, requestId);
      seen.add(requestId);
      result.denied.push(requestId);
      continue;
    }
    mintFromPending(opts.runDir, opts.secret, pending, now);
    await consumePending(opts.runDir, requestId);
    seen.add(requestId);
    result.granted.push(requestId);
  }
  return result;
}

export function registerApprovalDispatcher(opts: RegisterApprovalDispatcherOpts): { stop(): Promise<void> } {
  const pollMs = opts.pollMs ?? 250;
  const seen = new Set<string>();
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    if (stopped) return;
    inFlight = inFlight.then(async () => {
      if (stopped) return;
      await dispatchOnce({
        runDir: opts.runDir,
        secret: opts.secret,
        callback: opts.callback,
        now: opts.now,
        seen,
      });
    }).catch(() => {
      /* fail-closed: a tick error must not mint and must not crash the poller */
    });
  };
  const timer = setInterval(tick, pollMs);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
