import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { CompletedRun, MemoryConfig } from "../types.js";

export type FlushSnapshot = {
  sessionId: string;
  timestamp: string;
  runs: CompletedRun[];
  // Narrative is generated in-process by MemoryCore using Pi's configured provider.
  // flush.mjs is a pure I/O script — it writes the log and handles Obsidian sync only.
  narrative: string;
  logDir: string;
  sentinelPath: string;   // HIGH-6: explicit path so flush.mjs and MemoryCore always agree
  obsidianVaultPath?: string;
  obsidianDailyNotesSubdir: string;
};

export async function writeSnapshot(
  sessionId: string,
  runs: CompletedRun[],
  config: MemoryConfig,
  narrative: string,
  logDir: string,
  sentinelPath: string,
): Promise<string> {
  const snapshot: FlushSnapshot = {
    sessionId,
    timestamp: new Date().toISOString(),
    runs,
    narrative,
    logDir,
    sentinelPath,
    obsidianDailyNotesSubdir: config.obsidianDailyNotesSubdir,
    ...(config.obsidianVaultPath ? { obsidianVaultPath: config.obsidianVaultPath } : {}),
  };
  const path = join(tmpdir(), `pi-flush-${sessionId}.json`);
  await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");
  return path;
}
