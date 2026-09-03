import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { runObservers } from "../controller/lane-runner.js";
import type { RunState } from "../engine/types.js";
import { readRunSecret, runDirPath } from "../engine/state.js";
import { Observer } from "../observer/events.js";
import { hashArgs, mintToken, TOKEN_OPS, type TokenOp } from "../safety/tokens.js";
import { queueStateFor, readQueue, writeQueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";
import type { PendingApproval } from "../worker/request-approval.js";
import { pendingApprovalPath } from "../worker/request-approval.js";

export interface GrantContext {
  hasUI: boolean;
  ui: {
    confirm(title: string, initial?: string): Promise<boolean | string | undefined>;
  };
}

async function loadPending(runDir: string): Promise<PendingApproval> {
  let names: string[] = [];
  try {
    names = (await readdir(join(runDir, "approvals", "pending"))).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw err;
  }
  if (names.length === 0) throw new Error("grant: no pending approval file");
  const id = names[0]!.slice(0, -".json".length);
  const raw = JSON.parse(await readFile(pendingApprovalPath(runDir, id), "utf8")) as PendingApproval;
  return raw;
}

function confirmed(value: boolean | string | undefined): boolean {
  return value === true || value === "yes" || value === "Yes";
}

function tokenOp(pending: PendingApproval): TokenOp {
  return (TOKEN_OPS as readonly string[]).includes(pending.op) ? (pending.op as TokenOp) : "bash";
}

export async function runGrant(parsed: ParsedFactoryArgs, deps: FactoryDeps, ctx: GrantContext): Promise<RunState> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("grant: missing run id");
  const queue = await readQueue(deps.runsDir);
  const entry = queue.entries.find((e) => e.ref === ref || e.runId === ref);
  const runId = entry?.runId ?? ref;
  const runDir = runDirPath(deps.runsDir, runId);
  const pending = await loadPending(runDir);
  if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
    throw new Error("grant: interactive UI required");
  }
  const nonce = pending.requestId;
  const ok = await ctx.ui.confirm(`Grant ${pending.op} once?\n${pending.command}\nnonce ${nonce}`, "no");
  if (!confirmed(ok)) throw new Error("grant: confirmation refused");

  const secret = await readRunSecret(runDir);
  const op = tokenOp(pending);
  const argsHash = op === "bash" || op === pending.op
    ? hashArgs(op, op === "write" || op === "edit" ? { path: pending.command } : { command: pending.command })
    : hashArgs("bash", { command: pending.command });
  const token = mintToken(runDir, secret, { op, argsHash, ttlSeconds: 300, runId });

  const obs = runObservers.get(runId) ?? new Observer(runDir, runId);
  if (!runObservers.has(runId)) runObservers.set(runId, obs);
  obs.emit({
    category: "approval",
    type: "factory.approval.granted",
    runId,
    data: { requestId: pending.requestId, tokenId: token.tokenId, op },
  });
  await obs.flush();

  const state = await deps.engine.resumeRun(runId);
  const latest = await readQueue(deps.runsDir);
  const live = latest.entries.find((e) => e.runId === runId || e.ref === ref);
  if (live !== undefined) {
    live.state = queueStateFor(state.status, state.pauseForUser, state.escalation?.code);
    live.runId = state.runId;
    live.updatedAt = new Date().toISOString();
    if (live.state !== "blocked") delete live.waitingOn;
    await writeQueue(deps.runsDir, latest);
  }
  return state;
}
