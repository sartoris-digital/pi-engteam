import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * @param {string} sessionId
 * @param {string} timestamp
 * @param {Array<{ runId: string, workflow: string, goal: string, verdict: string, changedFiles?: string[] }>} runs
 * @param {string} summary
 * @returns {string}
 */
export function buildSessionEntry(sessionId, timestamp, runs, summary) {
  // Times are UTC — append Z so readers know the timezone
  const time = new Date(timestamp).toISOString().slice(11, 16) + "Z";

  const runsSection =
    runs.length === 0
      ? "_No runs completed_"
      : [
          "| Run ID | Workflow | Goal | Verdict |",
          "|--------|----------|------|---------|",
          ...runs.map(
            (run) =>
              `| \`${run.runId.slice(0, 6)}\` | ${run.workflow} | ${run.goal} | ${run.verdict} |`,
          ),
        ].join("\n");

  const changedFiles = [...new Set(runs.flatMap((run) => run.changedFiles ?? []))];
  const changedFilesSection =
    changedFiles.length === 0
      ? "_No files changed_"
      : changedFiles.map((file) => `- ${file}`).join("\n");

  return [
    `## Session ${sessionId} — ${time}`,
    "",
    "### Runs",
    runsSection,
    "",
    "### Changed Files",
    changedFilesSection,
    "",
    "### Summary",
    summary,
    "",
    "---",
    "",
  ].join("\n");
}

/**
 * @param {string} logPath
 * @param {string} sessionId
 * @param {string} entry
 * @returns {Promise<void>}
 */
export async function appendOrReplaceSession(logPath, sessionId, entry) {
  await mkdir(dirname(logPath), { recursive: true });

  let existing;
  try {
    existing = await readFile(logPath, "utf8");
  } catch {
    const date = logPath.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1] ?? new Date().toISOString().slice(0, 10);
    existing = `# Daily Log: ${date}\n\n`;
  }

  const startMarker = `## Session ${sessionId}`;
  const startIndex = existing.indexOf(startMarker);

  if (startIndex === -1) {
    await writeFile(logPath, `${existing}${entry}`, "utf8");
    return;
  }

  const nextIndex = existing.indexOf("\n## Session ", startIndex + startMarker.length);
  const endIndex = nextIndex === -1 ? existing.length : nextIndex + 1;
  const updated = `${existing.slice(0, startIndex)}${entry}${existing.slice(endIndex)}`;
  await writeFile(logPath, updated, "utf8");
}
