import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, readdir, rm, stat, writeFile, realpath } from "fs/promises";
import { join, resolve } from "path";
import { loadRunState } from "../adw/RunState.js";

// Same shape as /learn's runId guard. Codex P4 round-1 C-1: previously
// /run-rollback `../../target` would operate outside runsDir if the path
// existed.
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
      if (!RUN_ID_RE.test(runId)) {
        ctx.ui.notify(
          `Invalid runId '${runId}': must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}.`,
          "error",
        );
        return;
      }
      const runDir = join(runsDir, runId);
      try {
        const realRunsDir = await realpath(runsDir);
        const realRunDir = await realpath(runDir);
        if (!realRunDir.startsWith(realRunsDir + "/") && realRunDir !== realRunsDir) {
          ctx.ui.notify(`Run dir resolves outside runsDir; refusing rollback.`, "error");
          return;
        }
        await stat(runDir);
      } catch {
        ctx.ui.notify(`Run dir ${runDir} does not exist`, "error");
        return;
      }
      void resolve;
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
