import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRunState, saveRunState } from "../adw/RunState.js";

export function registerRunCancelCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand("run-cancel", {
    description:
      "Request graceful cancellation of a running workflow at the next step boundary. State is preserved. Usage: /run-cancel <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /run-cancel <runId>", "error");
        return;
      }
      const state = await loadRunState(runsDir, runId);
      if (!state) {
        ctx.ui.notify(`Run ${runId} not found`, "error");
        return;
      }
      const terminal = ["succeeded", "failed", "aborted"] as const;
      if (terminal.includes(state.status as any)) {
        ctx.ui.notify(`Run ${runId} is already in terminal status '${state.status}'`, "warning");
        return;
      }
      await saveRunState(runsDir, { ...state, phase: "cancelling" });
      ctx.ui.notify(
        `Run ${runId} marked phase=cancelling. The engine will stop at the next step boundary and preserve all state.`,
        "info",
      );
    },
  });
}
