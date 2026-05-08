import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadRunState, saveRunState, withRunStateLock } from "../adw/RunState.js";

/**
 * Deprecated in v1: kept as an alias for /run-cancel. Will be removed in the
 * next major. New code and docs should reference /run-cancel.
 *
 * Codex round-4 H-1: shares the same load-modify-save mutex discipline as
 * /run-cancel so the alias is not a back door past the round-3 cancel race fix.
 */
export function registerRunAbortCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand("run-abort", {
    description:
      "[deprecated] Alias for /run-cancel. Marks the run for graceful cancellation. Usage: /run-abort <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /run-abort <runId>", "error");
        return;
      }
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
        `Run ${runId} marked phase=cancelling (alias of /run-cancel). The engine will stop at the next step boundary.`,
        "info",
      );
    },
  });
}
