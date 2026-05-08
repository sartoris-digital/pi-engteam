import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";
import { isSafeRunId, RUN_ID_RE } from "../adw/RunState.js";

export function registerRunResumeCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand("run-resume", {
    description: "Resume a paused or interrupted workflow run. Usage: /run-resume <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /run-resume <runId>", "error");
        return;
      }
      // Phase 5.5 round-2 C1: reject traversal-shaped runIds at the user
      // boundary before they reach engine.resumeRun → loadRunState.
      if (!isSafeRunId(runId)) {
        ctx.ui.notify(
          `Invalid runId '${runId}': must match ${RUN_ID_RE.source}.`,
          "error",
        );
        return;
      }
      void engine.resumeRun(runId);
      ctx.ui.notify(`Run ${runId} resuming...`, "info");
    },
  });
}
