// src/commands/learn.ts
// `/learn [runId]` — invoke the LearnerOrchestrator. With no arg, processes
// gap files from every recent run; with a runId, scopes to that run.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import { runLearner } from "../learner/LearnerOrchestrator.js";

export function parseLearnArgs(raw: string): { runId?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  return { runId: trimmed.split(/\s+/)[0] };
}

export async function discoverGapFiles(runsDir: string, runId?: string): Promise<string[]> {
  if (runId) {
    const p = join(runsDir, runId, "learning", "gaps.jsonl");
    return existsSync(p) ? [p] : [];
  }
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(runsDir, e, "learning", "gaps.jsonl");
    if (existsSync(p)) out.push(p);
  }
  return out;
}

export function registerLearnCommand(
  pi: ExtensionAPI,
  team: TeamRuntime,
  runsDir: string,
): void {
  pi.registerCommand("learn", {
    description:
      "Process verifier gap logs to author new verifier scripts. Usage: /learn [runId]",
    handler: async (args, ctx) => {
      const { runId } = parseLearnArgs(args);
      const engineeringDir = join(homedir(), ".pi", "engineering-team");
      const scriptsDir = join(engineeringDir, "verifier-scripts");
      const stagingDir = join(scriptsDir, ".staging");
      const versionsDir = join(scriptsDir, ".versions");
      const fixturesDir = join(scriptsDir, ".fixtures");
      const changelogPath = join(scriptsDir, "CHANGELOG.md");

      const gapsPaths = await discoverGapFiles(runsDir, runId);
      if (gapsPaths.length === 0) {
        ctx.ui.notify(
          runId
            ? `No gaps.jsonl found for run ${runId}.`
            : `No gap files found in ${runsDir}.`,
          "info",
        );
        return;
      }

      const reportRunDir = runId
        ? join(runsDir, runId, "learning")
        : join(runsDir, "_learner", new Date().toISOString().replace(/[:.]/g, "-"));

      ctx.ui.notify(`Learner processing ${gapsPaths.length} gap file(s)…`, "info");

      try {
        const result = await runLearner({
          team,
          learnerAgentName: "learner",
          judgeAgentName: "judge",
          scriptsDir,
          stagingDir,
          versionsDir,
          fixturesDir,
          changelogPath,
          gapsPaths,
          reportRunDir,
        });
        ctx.ui.notify(
          [
            `Learner complete:`,
            `- gaps processed:  ${result.gapsProcessed}`,
            `- scripts proposed: ${result.scriptsProposed}`,
            `- scripts approved: ${result.scriptsApproved}`,
            `- scripts promoted: ${result.scriptsPromoted}`,
            `- escalations: ${result.escalations.length}`,
            `report → ${result.reportPath}`,
          ].join("\n"),
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Learner failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
