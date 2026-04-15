import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { appendOrReplaceSession, buildSessionEntry } from "./lib/logWriter.mjs";
import { loadConfig } from "./lib/config.mjs";
import { readLastNTurns } from "./lib/transcript.mjs";

/**
 * Call the Anthropic API to generate a narrative summary.
 * Requires ANTHROPIC_API_KEY environment variable.
 * MED-2: 60-second timeout via AbortSignal.timeout (Node 20+).
 *
 * Replace this function body if/when Pi exposes a standalone SDK call.
 *
 * @param {string} prompt
 * @param {string} model
 * @returns {Promise<string>}
 */
async function callAnthropicForNarrative(prompt, model) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return "(narrative unavailable: ANTHROPIC_API_KEY not set)";
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    // MED-2: abort after 60 s so stalled sockets don't leak a zombie process
    signal: AbortSignal.timeout(60_000),
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data.content?.find((part) => part.type === "text")?.text ?? "(empty response)";
}

/**
 * HIGH-5: compare symlink target via realpath to handle macOS /tmp → /private/tmp aliasing.
 *
 * @param {string} logPath
 * @param {{ obsidianVaultPath?: string, obsidianDailyNotesSubdir?: string }} snapshot
 * @returns {Promise<void>}
 */
async function ensureObsidianSymlink(logPath, snapshot) {
  if (!snapshot.obsidianVaultPath) return;

  const vaultDir = join(snapshot.obsidianVaultPath, snapshot.obsidianDailyNotesSubdir ?? "Daily");
  await mkdir(vaultDir, { recursive: true });

  const symlinkPath = join(vaultDir, basename(logPath));

  let symlinkExists = false;
  let symlinkPointsHere = false;

  try {
    const stat = await lstat(symlinkPath);
    symlinkExists = true;
    if (stat.isSymbolicLink()) {
      // Use realpath on both sides — handles macOS /tmp → /private/tmp aliasing
      const resolvedTarget = await realpath(symlinkPath).catch(() => null);
      const resolvedLog = await realpath(logPath).catch(() => logPath);
      symlinkPointsHere = resolvedTarget !== null && resolvedTarget === resolvedLog;
    }
  } catch {
    // ENOENT — symlink doesn't exist yet
  }

  if (symlinkExists && symlinkPointsHere) return; // already correct — no-op
  if (symlinkExists) return;                       // points elsewhere — user manages vault

  await symlink(logPath, symlinkPath);
}

async function main() {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) {
    console.error("[pi-memory] Usage: flush.mjs <snapshot-path>");
    process.exit(1);
  }

  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const config = await loadConfig();
  const maxTurns = snapshot.maxTurns ?? config.maxConversationTurns;
  const model = snapshot.flushModel ?? config.flushModel;
  const transcriptPath = snapshot.transcriptPath ?? "";

  // HIGH-6: sentinelPath is explicit in the snapshot — no derivation from logDir
  const sentinelPath = snapshot.sentinelPath;

  let success = false;
  try {
    const runsText =
      snapshot.runs.length === 0
        ? "No runs completed."
        : snapshot.runs
            .map((run) => `- ${run.workflow}: "${run.goal}" → ${run.verdict}`)
            .join("\n");

    const conversationText = await readLastNTurns(transcriptPath, maxTurns);

    const prompt = [
      "You are summarizing a Pi engineering session.",
      "",
      "Runs completed:",
      runsText,
      "",
      `Recent conversation (last ${maxTurns} turns):`,
      conversationText,
      "",
      "Write a 2-3 paragraph summary of what was attempted, what succeeded,",
      "what failed, and any key decisions made. Be concrete — name files,",
      "workflows, and goals. Do not pad. Do not repeat the runs list.",
    ].join("\n");

    const narrative = await callAnthropicForNarrative(prompt, model);
    const date = new Date(snapshot.timestamp).toISOString().slice(0, 10);
    const logPath = join(snapshot.logDir, `${date}.md`);
    const entry = buildSessionEntry(snapshot.sessionId, snapshot.timestamp, snapshot.runs, narrative);

    await appendOrReplaceSession(logPath, snapshot.sessionId, entry);
    await ensureObsidianSymlink(logPath, snapshot);

    console.log(`[pi-memory] flushed session ${snapshot.sessionId} -> ${logPath}`);
    success = true;
  } catch (error) {
    console.error("[pi-memory] flush failed:", error instanceof Error ? error.message : String(error));
  } finally {
    // MED-3: always write sentinel — prevents heartbeat from retrying forever on persistent failures
    if (sentinelPath) {
      await writeFile(sentinelPath, new Date().toISOString(), "utf8").catch(() => {});
    }
  }

  if (!success) process.exit(1);
}

main().catch((error) => {
  console.error("[pi-memory] fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
