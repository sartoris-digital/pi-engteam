import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MEMORY_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "engteam",
  "second-brain",
  "config.json",
);

export const DEFAULTS = {
  obsidianDailyNotesSubdir: "Daily",
  maxConversationTurns: 20,
  flushModel: "claude-haiku-4-5-20251001",
};

export function expandTilde(pathValue) {
  if (!pathValue) return pathValue;
  return pathValue.startsWith("~/") ? join(homedir(), pathValue.slice(2)) : pathValue;
}

export async function loadConfig(configPath = DEFAULT_MEMORY_CONFIG_PATH) {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      obsidianVaultPath: expandTilde(parsed.obsidianVaultPath),
    };
  } catch {
    return { ...DEFAULTS };
  }
}
