import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadRunState, saveRunState, withRunStateLock } from "../adw/RunState.js";

export function registerRunPlanModeCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand("run-plan-mode", {
    description: "Toggle plan mode for the active run: /run-plan-mode on|off",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg !== "on" && arg !== "off") {
        ctx.ui.notify("Usage: /run-plan-mode on|off", "error");
        return;
      }
      const planMode = arg === "on";

      try {
        const activeFile = join(runsDir, "active-run.txt");
        const runId = (await readFile(activeFile, "utf8")).trim();
        // Codex round-2 MEDIUM: previous version did a non-atomic writeFile
        // outside withRunStateLock, so it could (a) overwrite an ADWEngine
        // save that landed between the read and write, and (b) leave a
        // torn state.json on crash. Go through saveRunState (tmp + rename)
        // under the per-runId mutex.
        await withRunStateLock(runsDir, runId, async () => {
          const state = await loadRunState(runsDir, runId);
          if (!state) throw new Error("state not loadable");
          state.planMode = planMode;
          await saveRunState(runsDir, state);
        });
        ctx.ui.notify(`Plan mode ${planMode ? "enabled" : "disabled"} for run ${runId.slice(0, 8)}.`, "info");
      } catch {
        ctx.ui.notify("No active run found. Plan mode only applies during a running workflow.", "error");
      }
    },
  });
}
