import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { MemoryConfig } from "../types.js";

export const DEFAULT_MEMORY_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "engteam",
  "second-brain",
  "config.json",
);

export const MEMORY_DEFAULTS: MemoryConfig = {
  obsidianDailyNotesSubdir: "Daily",
  maxConversationTurns: 20,
  flushModel: "claude-haiku-4.5",
};

export function expandTilde(pathValue: string | undefined): string | undefined {
  if (pathValue === undefined) return undefined;
  return pathValue.startsWith("~/") ? join(homedir(), pathValue.slice(2)) : pathValue;
}

export async function loadMemoryConfig(
  configPath: string = DEFAULT_MEMORY_CONFIG_PATH,
): Promise<MemoryConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MemoryConfig>;
    return {
      ...MEMORY_DEFAULTS,
      ...parsed,
      obsidianVaultPath: expandTilde(parsed.obsidianVaultPath),
    };
  } catch {
    return { ...MEMORY_DEFAULTS };
  }
}
