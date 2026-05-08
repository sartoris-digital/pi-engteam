import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { lstat, mkdir, readdir, rename, rm, stat, writeFile, realpath } from "fs/promises";
import { join, sep } from "path";
import { randomBytes } from "crypto";
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
      try {
        // Codex round-2 C-1: lstat first — refuse to follow a symlinked run
        // directory. A symlink runId pointing at runsDir itself would
        // otherwise let realpath collapse to a parent we then wipe.
        const lst = await lstat(runDir);
        if (lst.isSymbolicLink()) {
          ctx.ui.notify(`Run dir ${runId} is a symlink; refusing rollback.`, "error");
          return;
        }
        realRunsDir = await realpath(runsDir);
        const realRunDir = await realpath(runDir);
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

      // Codex round-4 C-2: atomically quarantine the run dir before any
      // destructive op. A rename collapses the validated path into a
      // fresh, owned name; once renamed, no symlink-swap on the original
      // path can redirect our subsequent readdir/rm. The quarantine name
      // is locally unique per call (random token) and lives directly
      // under runsDir so the strict-child invariant still holds.
      const quarantineName = `.rollback-${randomBytes(8).toString("hex")}-${runId}`;
      const quarantineDir = join(realRunsDir, quarantineName);
      try {
        await rename(runDir, quarantineDir);
      } catch (err) {
        ctx.ui.notify(
          `Failed to quarantine run dir for rollback: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }
      // Re-verify quarantine target is not a symlink and is contained.
      try {
        const qlst = await lstat(quarantineDir);
        if (qlst.isSymbolicLink()) {
          ctx.ui.notify(`Quarantined run dir resolved as symlink; aborting wipe.`, "error");
          return;
        }
      } catch {
        ctx.ui.notify(`Quarantined run dir vanished before wipe.`, "error");
        return;
      }

      // Wipe the quarantined tree. Each entry is lstat'd defensively;
      // symlinks are unlinked without recursion through their target.
      const entries = await readdir(quarantineDir);
      for (const name of entries) {
        const childPath = join(quarantineDir, name);
        try {
          const childLst = await lstat(childPath);
          if (childLst.isSymbolicLink()) {
            await rm(childPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        await rm(childPath, { recursive: true, force: true });
      }
      // Drop the now-empty quarantine container.
      try {
        await rm(quarantineDir, { recursive: true, force: true });
      } catch {
        // Best effort; main wipe already happened.
      }

      // Recreate a fresh runDir with only cancelled.log.
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
