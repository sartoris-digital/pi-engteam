import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunResumeCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand("run-resume", {
    description: "Resume a paused or interrupted workflow run. Usage: /run-resume <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /run-resume <runId>", "error");
        return;
      }
      void engine.resumeRun(runId);
      ctx.ui.notify(`Run ${runId} resuming...`, "info");
    },
  });
}
