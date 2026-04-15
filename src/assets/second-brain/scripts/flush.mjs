import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { appendOrReplaceSession, buildSessionEntry } from "./lib/logWriter.mjs";

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

  // HIGH-6: sentinelPath is explicit in the snapshot — no derivation from logDir
  const sentinelPath = snapshot.sentinelPath;

  let success = false;
  try {
    // The narrative is pre-generated in-process by MemoryCore using Pi's configured
    // provider. flush.mjs is a pure I/O script — no API call needed here.
    const narrative = snapshot.narrative ?? "(narrative unavailable)";

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
