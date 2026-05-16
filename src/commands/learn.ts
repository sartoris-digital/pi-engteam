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

// runId must be a single safe segment (no path separators, no `..`, no
// surrounding whitespace, alphanumeric+`-_` only). Codex P3.5 round-1 M-12:
// previously a runId of `../../target` would join into runsDir paths.
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function parseLearnArgs(raw: string): { runId?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const candidate = trimmed.split(/\s+/)[0];
  if (!RUN_ID_RE.test(candidate)) {
    throw new Error(
      `Invalid runId '${candidate}': must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}.`,
    );
  }
  return { runId: candidate };
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
  emitEvent?: (evt: { category: "safety"; type: "verifier_script_updated"; payload: Record<string, unknown> }) => void,
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

      // Codex round-6 HIGH: the learner orchestrator now requires a
      // runId so it can verify the judge's GrantApproval actually minted
      // a verifier-script-update token under that run before promoting.
      // Synthesize a learner-scoped runId when /learn is invoked without
      // one, and bind the TeamRuntime to it so the judge subprocess writes
      // its approvals under the same dir we'll scan.
      const effectiveRunId = runId || `_learner-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      team.setRunId(effectiveRunId);

      const reportRunDir = runId
        ? join(runsDir, runId, "learning")
        : join(runsDir, effectiveRunId);

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
          runsDir,
          runId: effectiveRunId,
          // Codex P3.5 round-1 LOW-15: emit observability event on each promote.
          onPromote: (script, version) => {
            emitEvent?.({
              category: "safety",
              type: "verifier_script_updated",
              payload: { script, version, ts: new Date().toISOString() },
            });
          },
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
