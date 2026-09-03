import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerController } from "./controller/index.js";
import { runContextFromEnv } from "./safety/context.js";
import { registerWorker } from "./worker/index.js";

export type ExtensionMode = "worker" | "controller";

/**
 * True when the env carries a run context at all. A malformed one (RunContextError) counts:
 * the process is still a worker, and registerWorker refuses it with exit 78 rather than
 * quietly becoming a full-power controller inside a worker subprocess.
 */
function carriesRunContext(env: NodeJS.ProcessEnv): boolean {
  try {
    return runContextFromEnv(env) !== null;
  } catch {
    return true;
  }
}

/** Worker mode needs both the agent-mode flag and a run context; anything else is the controller. */
export function selectMode(env: NodeJS.ProcessEnv): ExtensionMode {
  return env.PI_SDLC_AGENT_MODE === "1" && carriesRunContext(env) ? "worker" : "controller";
}

/** Async so Pi can await the factory (D20). */
export async function activate(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): Promise<ExtensionMode> {
  const mode = selectMode(env);
  if (mode === "worker") registerWorker(pi, { env });
  else await registerController(pi);
  return mode;
}

/** Pi extension entry: the same file runs in the operator's session and inside every `pi -p` worker. */
export default async function (pi: ExtensionAPI): Promise<void> {
  await activate(pi, process.env);
}
