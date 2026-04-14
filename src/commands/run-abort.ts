import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunAbortCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand("run-abort", {
    description:
      "Abort a running workflow, revoke approval tokens, and clean up. Usage: /run-abort <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /run-abort <runId>", "error");
        return;
      }
      await engine.abortRun(runId);
      ctx.ui.notify(`Run ${runId} aborted.`, "info");
    },
  });
}
