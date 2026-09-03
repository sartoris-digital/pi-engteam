import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Block, RunContext } from "./context.js";
import { controllerHardBlock, hardBlock } from "./layer-a.js";
import { readOnlyBlock } from "./layer-b.js";
import { defaultDenyBlock } from "./layer-c.js";
import { EMPTY_POLICY, domainBlock, loadDomainPolicy, type DomainPolicy } from "./layer-d.js";
import { defaultPathEnv, type PathEnv } from "./paths.js";
import { fileTokenSource, type TokenSource } from "./tokens.js";

export type GuardHost = Pick<ExtensionAPI, "on">;

/** Structural stand-ins: ToolCallEvent / ToolCallEventResult are not documented 0.84.x exports (D25). */
export interface ToolCallEventLike {
  type?: string;
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown>;
}
export type ToolCallBlock = { block: true; reason?: string; terminate?: boolean };

export interface GuardDeps {
  policy?: DomainPolicy;
  tokens?: TokenSource;
  env?: PathEnv;
  /** Lowercased tool allowlist. When set (including []), tools outside it are blocked. */
  allowedTools?: string[];
}

export interface GuardStats {
  evaluated: number;
  blocked: { A: number; B: number; C: number; D: number };
}

export interface InstalledGuard {
  ctx: RunContext;
  stats: GuardStats;
  policyError: string | null;
  evaluate(tool: string, input: Record<string, unknown>): Block | null;
}

const POLICY_GATED_TOOLS = new Set(["write", "edit", "bash", "powershell", "read", "grep", "glob", "find", "ls"]);
const WORKER_INTRINSIC_TOOLS = new Set(["verdictemit", "requestapproval"]);

function toolInAllowlist(tool: string, allow: string[] | undefined): boolean {
  if (allow === undefined) return true;
  const name = tool.toLowerCase();
  if (WORKER_INTRINSIC_TOOLS.has(name)) return true;
  return allow.includes(name);
}

/** Synchronous run-secret read. Named `…Sync` so it never collides with the engine's async `readRunSecret`. */
export function readRunSecretSync(runDir: string): string | null {
  try {
    const secret = readFileSync(join(runDir, ".secret"), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

export function evaluateToolCall(tool: string, input: Record<string, unknown>, ctx: RunContext, deps: Required<GuardDeps>): Block | null {
  return (
    hardBlock(tool, input, ctx, deps.env) ??
    readOnlyBlock(tool, input, ctx, deps.env) ??
    defaultDenyBlock(tool, input, ctx, deps.tokens, deps.env) ??
    domainBlock(tool, input, ctx, deps.policy, deps.env)
  );
}

function toResult(block: Block | null): ToolCallBlock | undefined {
  if (block === null) return undefined;
  return { block: true, reason: block.reason, terminate: block.terminate === true };
}

export function installSafetyGuard(pi: GuardHost, ctx: RunContext | null, deps: GuardDeps = {}): InstalledGuard | null {
  if (ctx === null) return null;
  const env = deps.env ?? defaultPathEnv();
  let policy: DomainPolicy = EMPTY_POLICY;
  let policyError: string | null = null;
  if (deps.policy !== undefined) {
    policy = deps.policy;
  } else {
    try {
      policy = loadDomainPolicy(ctx.policyFile, ctx.policySha, ctx.agent);
    } catch (error) {
      policyError = (error as Error).message;
    }
  }
  const tokens = deps.tokens ?? fileTokenSource(ctx.runDir, readRunSecretSync(ctx.runDir), ctx.runId);
  const full: Required<Omit<GuardDeps, "allowedTools">> = { policy, tokens, env };
  const allowlist = deps.allowedTools ?? ctx.tools;
  const stats: GuardStats = { evaluated: 0, blocked: { A: 0, B: 0, C: 0, D: 0 } };
  const evaluate = (tool: string, input: Record<string, unknown>): Block | null => {
    stats.evaluated++;
    const a = hardBlock(tool, input, ctx, env);
    if (a !== null) {
      stats.blocked.A++;
      return a;
    }
    const b = readOnlyBlock(tool, input, ctx, env);
    if (b !== null) {
      stats.blocked.B++;
      return b;
    }
    const c = defaultDenyBlock(tool, input, ctx, tokens, env);
    if (c !== null) {
      stats.blocked.C++;
      return c;
    }
    const d =
      policyError !== null && POLICY_GATED_TOOLS.has(tool)
        ? { block: true as const, layer: "D" as const, reason: `[Layer D] policy unavailable, failing closed: ${policyError}` }
        : domainBlock(tool, input, ctx, full.policy, env);
    if (d !== null) stats.blocked.D++;
    return d;
  };
  pi.on("tool_call", ((event: ToolCallEventLike): ToolCallBlock | undefined => {
    if (!toolInAllowlist(event.toolName, allowlist)) {
      return { block: true, reason: `tool "${event.toolName}" is not in this agent's PI_SDLC_TOOLS allowlist` };
    }
    const input = (event.input ?? {}) as Record<string, unknown>;
    return toResult(evaluate(event.toolName, input));
  }) as never);
  return { ctx, stats, policyError, evaluate };
}

export function installControllerHardBlockers(pi: GuardHost, env: PathEnv = defaultPathEnv()): void {
  pi.on("tool_call", ((event: ToolCallEventLike): ToolCallBlock | undefined => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const block = controllerHardBlock(event.toolName, input, env);
    return block === null ? undefined : { block: true, reason: block.reason, terminate: false };
  }) as never);
}
