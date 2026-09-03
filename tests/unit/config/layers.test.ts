import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  committedConfigPath,
  expandHome,
  findRepoEntry,
  globalConfigPath,
  localConfigPath,
  readCommitted,
  readGlobal,
  readLocal,
  readRepoOverrides,
} from "../../../src/config/layers.js";
import { ConfigError } from "../../../src/config/errors.js";

let home: string;
let repo: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sdlc-home-"));
  repo = await mkdtemp(join(tmpdir(), "sdlc-repo-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("layer files", () => {
  it("resolve to the documented locations", () => {
    expect(globalConfigPath("/h")).toBe("/h/factory.json");
    expect(committedConfigPath("/r")).toBe("/r/.pi/factory.json");
    expect(localConfigPath("/r")).toBe("/r/.pi/factory.local.json");
  });

  it("missing files read as empty layers", async () => {
    expect(await readGlobal(home)).toEqual({ schemaVersion: 1 });
    expect(await readCommitted(repo)).toEqual({});
    expect(await readLocal(repo)).toEqual({});
  });

  it("reads and validates each file, stripping schemaVersion from repo files", async () => {
    await writeFile(
      join(home, "factory.json"),
      JSON.stringify({ schemaVersion: 1, operator: { maxLanes: 1 }, defaults: { steering: "elevated" } }),
    );
    await mkdir(join(repo, ".pi"));
    await writeFile(join(repo, ".pi", "factory.json"), JSON.stringify({ schemaVersion: 1, maxDiffLines: 100 }));
    await writeFile(
      join(repo, ".pi", "factory.local.json"),
      JSON.stringify({ schemaVersion: 1, checksConcurrency: 4, setupCommand: null }),
    );
    expect(await readGlobal(home)).toEqual({
      schemaVersion: 1,
      operator: { maxLanes: 1 },
      defaults: { steering: "elevated" },
    });
    expect(await readCommitted(repo)).toEqual({ maxDiffLines: 100 });
    expect(await readLocal(repo)).toEqual({ checksConcurrency: 4, setupCommand: null });
  });

  it("names the file in parse and schema errors", async () => {
    const file = join(repo, ".pi", "factory.local.json");
    await mkdir(join(repo, ".pi"));
    await writeFile(file, "{ not json");
    await expect(readLocal(repo)).rejects.toMatchObject({ code: "parse", file });

    await writeFile(file, JSON.stringify({ schemaVersion: 1, steerng: "always" }));
    const err = await readLocal(repo).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toBe(`${file}: unknown key "steerng"`);
    expect((err as ConfigError).file).toBe(file);
  });

  it("rejects a top-level array or scalar", async () => {
    await writeFile(join(home, "factory.json"), "[]");
    await expect(readGlobal(home)).rejects.toMatchObject({ code: "parse" });
  });
});

describe("repos[] lookup", () => {
  it("expands ~ against the given home", () => {
    expect(expandHome("~/work/app", "/Users/op")).toBe("/Users/op/work/app");
    expect(expandHome("~", "/Users/op")).toBe("/Users/op");
    expect(expandHome("/abs", "/Users/op")).toBe("/abs");
    expect(expandHome("~user/x", "/Users/op")).toBe("~user/x");
  });

  it("matches the registered path by resolved location", () => {
    const global = {
      schemaVersion: 1 as const,
      repos: [
        { path: "/elsewhere" },
        { path: `${repo}/`, remote: "upstream", overrides: { maxChangedFiles: 3 } },
      ],
    };
    expect(findRepoEntry(global, repo)?.remote).toBe("upstream");
    expect(findRepoEntry(global, join(repo, "sub", ".."))?.remote).toBe("upstream");
    expect(readRepoOverrides(global, repo)).toEqual({ maxChangedFiles: 3 });
    expect(readRepoOverrides({ schemaVersion: 1 }, repo)).toEqual({});
    expect(findRepoEntry({ schemaVersion: 1, repos: [{ path: "/elsewhere" }] }, repo)).toBeUndefined();
  });
});
