import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runContextFromEnv, type RunContext } from "../safety/context.js";
import { installSafetyGuard } from "../safety/guard.js";
import { createAskHostTool } from "./ask-host.js";
import { createRequestApprovalTool } from "./request-approval.js";
import { createVerdictEmitTool } from "./verdict-emit.js";

/** EX_CONFIG: the worker refused to start because its environment is not a valid factory run. */
export const WORKER_REFUSED_EXIT_CODE = 78;

/**
 * Structural shape of a blocking tool_call result. The Pi event types are not documented exports
 * of @earendil-works/pi-coding-agent 0.84.x, so nothing here imports them by name.
 */
interface ToolCallBlock {
  block: true;
  reason: string;
  terminate?: boolean;
}

export interface RegisterWorkerOptions {
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export function policyShaOf(policyFile: string): string {
  return createHash("sha256").update(readFileSync(policyFile)).digest("hex");
}

interface Resolved {
  exit: (code: number) => void;
  log: (message: string) => void;
}

/** Fail closed: block every tool call, then leave. A worker without a guard must never run a model turn. */
function refuse(pi: ExtensionAPI, reason: string, { exit, log }: Resolved): null {
  log(`[pi-sdlc-factory] worker refused to start: ${reason}`);
  pi.on("tool_call", (): ToolCallBlock => ({ block: true, reason: `pi-sdlc-factory worker refused to start: ${reason}`, terminate: true }));
  exit(WORKER_REFUSED_EXIT_CODE);
  return null;
}

export function registerWorker(pi: ExtensionAPI, opts: RegisterWorkerOptions = {}): RunContext | null {
  const env = opts.env ?? process.env;
  const resolved: Resolved = {
    exit: opts.exit ?? ((code: number) => process.exit(code)),
    log: opts.log ?? ((message: string) => console.error(message)),
  };

  // runContextFromEnv returns null for an absent/partial context and throws RunContextError for a
  // present-but-malformed one; both are refusals here, and neither may escape into the Pi session.
  let ctx: RunContext | null;
  try {
    ctx = runContextFromEnv(env);
  } catch (err) {
    return refuse(pi, `run context is malformed: ${(err as Error).message}`, resolved);
  }
  if (ctx === null) return refuse(pi, "no run context in the environment (PI_SDLC_* incomplete)", resolved);

  const verdictFile = env.PI_SDLC_VERDICT_FILE;
  if (!verdictFile) return refuse(pi, "PI_SDLC_VERDICT_FILE is not set", resolved);

  let actualSha: string;
  try {
    actualSha = policyShaOf(ctx.policyFile);
  } catch (err) {
    return refuse(pi, `policy snapshot unreadable: ${(err as Error).message}`, resolved);
  }
  if (actualSha !== ctx.policySha) {
    return refuse(pi, `policy snapshot sha mismatch (expected ${ctx.policySha}, got ${actualSha})`, resolved);
  }

  installSafetyGuard(pi, ctx);
  pi.registerTool(createVerdictEmitTool({ verdictFile, expectedStep: ctx.stage, runId: ctx.runId, exit: resolved.exit }));
  pi.registerTool(createRequestApprovalTool({ runDir: ctx.runDir, runId: ctx.runId, stage: ctx.stage, agent: ctx.agent }));
  pi.registerTool(createAskHostTool({ runDir: ctx.runDir }));
  return ctx;
}
