import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { loadRunState } from "../adw/RunState.js";

export function registerRunRollbackCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand("run-rollback", {
    description:
      "Wipe a run's directory, leaving only a debug cancelled.log. Use when /run-cancel did not take. Usage: /run-rollback <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /run-rollback <runId>", "error");
        return;
      }
      const runDir = join(runsDir, runId);
      try {
        await stat(runDir);
      } catch {
        ctx.ui.notify(`Run dir ${runDir} does not exist`, "error");
        return;
      }
      const state = await loadRunState(runsDir, runId);
      const record = {
        runId,
        rolledBackAt: new Date().toISOString(),
        priorStatus: state?.status,
        priorPhase: state?.phase,
        currentStep: state?.currentStep,
        workflow: state?.workflow,
        goal: state?.goal,
      };

      const entries = await readdir(runDir);
      for (const name of entries) {
        if (name === "cancelled.log") continue;
        await rm(join(runDir, name), { recursive: true, force: true });
      }
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "cancelled.log"),
        JSON.stringify(record, null, 2) + "\n",
      );
      ctx.ui.notify(
        `Run ${runId} rolled back. Only ${join(runDir, "cancelled.log")} remains.`,
        "info",
      );
    },
  });
}
