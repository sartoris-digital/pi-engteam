import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_MEMORY_CONFIG_PATH,
  MEMORY_DEFAULTS,
  expandTilde,
  loadMemoryConfig,
} from "../../../src/memory/config.js";

describe("loadMemoryConfig", () => {
  it("returns defaults when config file is missing", async () => {
    const config = await loadMemoryConfig(join(tmpdir(), "missing-memory-config.json"));

    expect(config).toEqual(MEMORY_DEFAULTS);
  });

  it("merges partial config with defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-config-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        maxConversationTurns: 42,
        obsidianDailyNotesSubdir: "Brain/Daily",
      }),
      "utf8",
    );

    const config = await loadMemoryConfig(path);

    expect(config).toEqual({
      ...MEMORY_DEFAULTS,
      maxConversationTurns: 42,
      obsidianDailyNotesSubdir: "Brain/Daily",
    });
  });

  it("expands tilde in obsidianVaultPath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-config-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        obsidianVaultPath: "~/Documents/Vault",
      }),
      "utf8",
    );

    const config = await loadMemoryConfig(path);

    expect(config.obsidianVaultPath).toBe(join(homedir(), "Documents/Vault"));
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
    expect(expandTilde(undefined)).toBeUndefined();
    expect(DEFAULT_MEMORY_CONFIG_PATH).toContain(".pi/engteam/second-brain/config.json");
  });
});
