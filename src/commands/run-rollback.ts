import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { lstat, mkdir, readdir, rm, stat, writeFile, realpath } from "fs/promises";
import { join, sep } from "path";
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
      let realRunsDir: string;
      let realRunDir: string;
      try {
        // Codex round-2 C-1: lstat first — refuse to follow a symlinked run
        // directory. A symlink runId pointing at runsDir itself (or anywhere
        // outside) would otherwise let realpath collapse to a parent we then
        // wipe.
        const lst = await lstat(runDir);
        if (lst.isSymbolicLink()) {
          ctx.ui.notify(`Run dir ${runId} is a symlink; refusing rollback.`, "error");
          return;
        }
        realRunsDir = await realpath(runsDir);
        realRunDir = await realpath(runDir);
        // Must be a STRICT child of runsDir. Equality (runDir resolves to
        // runsDir itself) is rejected.
        if (!realRunDir.startsWith(realRunsDir + sep) || realRunDir === realRunsDir) {
          ctx.ui.notify(`Run dir resolves outside runsDir; refusing rollback.`, "error");
          return;
        }
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

      // Codex round-3 C-2: defense-in-depth against TOCTOU symlink swap. All
      // destructive operations target realRunDir (the canonical, validated
      // path) instead of the original runDir. A swap of the original path
      // to a symlink between validation and use cannot redirect ops on the
      // canonical path. Each entry is also lstat'd and skipped if it has
      // become a symlink, so directory-traversal of swapped children is
      // contained.
      const entries = await readdir(realRunDir);
      for (const name of entries) {
        if (name === "cancelled.log") continue;
        const childPath = join(realRunDir, name);
        try {
          const childLst = await lstat(childPath);
          if (childLst.isSymbolicLink()) {
            // Don't traverse a swapped symlink; just unlink it (rm with
            // recursive on a symlink unlinks the link, not the target).
            await rm(childPath, { force: true });
            continue;
          }
        } catch {
          // Entry vanished between readdir and lstat; nothing to remove.
          continue;
        }
        await rm(childPath, { recursive: true, force: true });
      }
      await mkdir(realRunDir, { recursive: true });
      await writeFile(
        join(realRunDir, "cancelled.log"),
        JSON.stringify(record, null, 2) + "\n",
      );
      ctx.ui.notify(
        `Run ${runId} rolled back. Only ${join(realRunDir, "cancelled.log")} remains.`,
        "info",
      );
    },
  });
}
