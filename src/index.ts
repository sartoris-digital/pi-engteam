import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-sdlc-factory extension entry.
 *
 * v0 scaffold: registers nothing. Later tasks replace the body with the
 * controller/worker dispatch: when `process.env.PI_SDLC_AGENT_MODE === "1"` and
 * `runContextFromEnv(process.env)` returns a non-null context (it returns `null`
 * for a missing or partial worker env), call `registerWorker(pi)`; otherwise call
 * `registerController(pi)`. With no `PI_SDLC_RUN_ID` no tool_call handler is ever
 * registered.
 */
export default function piSdlcFactory(_pi: ExtensionAPI): void {
  // intentionally empty in v0 scaffold
}
