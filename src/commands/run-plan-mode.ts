import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

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
        const stateFile = join(runsDir, runId, "state.json");
        const state = JSON.parse(await readFile(stateFile, "utf8"));
        state.planMode = planMode;
        state.updatedAt = new Date().toISOString();
        await writeFile(stateFile, JSON.stringify(state, null, 2));
        ctx.ui.notify(`Plan mode ${planMode ? "enabled" : "disabled"} for run ${runId.slice(0, 8)}.`, "info");
      } catch {
        ctx.ui.notify("No active run found. Plan mode only applies during a running workflow.", "error");
      }
    },
  });
}
