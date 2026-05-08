import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRunState, saveRunState, withRunStateLock } from "../adw/RunState.js";

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
      // Codex round-3 C-1: serialize the load-modify-save through the per-runId
      // mutex so this write isn't interleaved with ADWEngine's level/terminal
      // saves.
      const outcome = await withRunStateLock(runsDir, runId, async () => {
        const state = await loadRunState(runsDir, runId);
        if (!state) return { kind: "not-found" as const };
        const terminal = ["succeeded", "failed", "aborted"] as const;
        if (terminal.includes(state.status as any)) {
          return { kind: "terminal" as const, status: state.status };
        }
        await saveRunState(runsDir, { ...state, phase: "cancelling" });
        return { kind: "ok" as const };
      });
      if (outcome.kind === "not-found") {
        ctx.ui.notify(`Run ${runId} not found`, "error");
        return;
      }
      if (outcome.kind === "terminal") {
        ctx.ui.notify(`Run ${runId} is already in terminal status '${outcome.status}'`, "warning");
        return;
      }
      ctx.ui.notify(
        `Run ${runId} marked phase=cancelling. The engine will stop at the next step boundary and preserve all state.`,
        "info",
      );
    },
  });
}
