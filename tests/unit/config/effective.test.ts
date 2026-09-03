import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadEffectiveConfig, resolveDefaultBase, sha256Hex } from "../../../src/config/effective.js";
import { DEFAULTS, GENERATED_DOC_PATTERNS } from "../../../src/config/defaults.js";
import { ConfigError } from "../../../src/config/errors.js";
import { NarrowingError } from "../../../src/config/narrowing.js";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

const trunk = async (): Promise<string> => "trunk";

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

describe("loadEffectiveConfig", () => {
  it("is built-in defaults plus resolved values when no layer file exists", async () => {
    const cfg = await loadEffectiveConfig(repo, { home, defaultBase: trunk });
    expect(cfg.operator.maxLanes).toBe(3);
    expect(cfg.operator.worktreeRoot).toBe(join(home, "worktrees"));
    expect(cfg.operator.codify.dispatch).toBe("exact");
    expect(cfg.repo.repoRoot).toBe(repo);
    expect(cfg.repo.remote).toBe("origin");
    expect(cfg.repo.branching).toEqual({ ...DEFAULTS.repo.branching, base: "trunk", target: "trunk" });
    expect(cfg.repo.sandbox).toBe("required");
    expect(cfg.repo.steering).toBe("always");
    expect(cfg.repo.planApproval).toBe("never");
    expect(cfg.repo.installTimeoutSeconds).toBe(300);
    expect(cfg.repo.generatedDocPatterns).toEqual([...GENERATED_DOC_PATTERNS]);
    expect(cfg.repo.setupCommand).toBeUndefined();
    expect(new Set(Object.values(cfg.provenance))).toEqual(new Set(["builtin"]));
    expect(cfg.configSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("merges the five layers in order and reports the winning layer per key", async () => {
    await writeJson(join(home, "factory.json"), {
      schemaVersion: 1,
      operator: { maxLanes: 5, workers: "headless", worktreeRoot: "~/lanes" },
      defaults: {
        maxDiffLines: 300,
        steering: "elevated",
        generatedDocPatterns: [...GENERATED_DOC_PATTERNS, "**/notes.ai.md"],
      },
      repos: [{ path: repo, remote: "upstream", overrides: { maxChangedFiles: 10 } }],
    });
    await writeJson(join(repo, ".pi", "factory.json"), {
      schemaVersion: 1,
      branching: { base: "develop" },
      checks: [{ name: "unit", argv: ["pnpm", "test"], reporter: "junit" }],
      maxDiffLines: 250,
      steering: "always",
      setupCommand: ["pnpm", "install"],
    });
    await writeJson(join(repo, ".pi", "factory.local.json"), {
      schemaVersion: 1,
      checksConcurrency: 2,
      setupCommand: null,
    });

    const cfg = await loadEffectiveConfig(repo, { home, defaultBase: trunk });

    expect(cfg.operator.maxLanes).toBe(5);
    expect(cfg.operator.workers).toBe("headless");
    expect(cfg.operator.maxLanesPerRepo).toBe(2);
    expect(cfg.operator.worktreeRoot).not.toContain("~");
    expect(cfg.operator.worktreeRoot.endsWith("/lanes")).toBe(true);
    expect(cfg.repo.branching.base).toBe("develop");
    expect(cfg.repo.branching.target).toBe("develop");
    expect(cfg.repo.branching.nameTemplate).toBe("factory/{tracker}-{id}-{slug}");
    expect(cfg.repo.maxDiffLines).toBe(250);
    expect(cfg.repo.maxChangedFiles).toBe(10);
    expect(cfg.repo.steering).toBe("always");
    expect(cfg.repo.checksConcurrency).toBe(2);
    expect(cfg.repo.checks).toEqual([{ name: "unit", argv: ["pnpm", "test"], reporter: "junit", timeoutSeconds: 900 }]);
    expect(cfg.repo.setupCommand).toBeUndefined();
    expect(cfg.repo.remote).toBe("upstream");
    expect(cfg.repo.generatedDocPatterns).toContain("**/notes.ai.md");
    expect(cfg.provenance).toMatchObject({
      "operator.maxLanes": "global",
      "operator.maxLanesPerRepo": "builtin",
      "operator.worktreeRoot": "global",
      "repo.branching.base": "committed",
      "repo.branching.target": "committed",
      "repo.branching.nameTemplate": "builtin",
      "repo.maxDiffLines": "committed",
      "repo.maxChangedFiles": "overrides",
      "repo.steering": "committed",
      "repo.checksConcurrency": "local",
      "repo.checks": "committed",
      "repo.generatedDocPatterns": "global",
      "repo.remote": "global",
      "repo.repoRoot": "builtin",
    });
    expect(cfg.provenance["repo.setupCommand"]).toBeUndefined();
  });

  it("rejects a loosening layer with the key and layer named", async () => {
    await writeJson(join(home, "factory.json"), { schemaVersion: 1, defaults: { steering: "always" } });
    await writeJson(join(repo, ".pi", "factory.local.json"), { schemaVersion: 1, steering: "elevated" });
    const err = await loadEffectiveConfig(repo, { home, defaultBase: trunk }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarrowingError);
    expect((err as NarrowingError).message).toBe(
      'config: layer "local" may not loosen "steering" (always → elevated)',
    );
  });

  it.each([
    { key: "steering", floor: "always", attempt: "elevated", layer: "committed" },
    { key: "steering", floor: "always", attempt: "never", layer: "committed" },
    { key: "planApproval", floor: "always", attempt: "elevated", layer: "committed" },
    { key: "planApproval", floor: "always", attempt: "never", layer: "committed" },
    { key: "steering", floor: "always", attempt: "elevated", layer: "overrides" },
    { key: "steering", floor: "always", attempt: "never", layer: "overrides" },
    { key: "planApproval", floor: "always", attempt: "elevated", layer: "overrides" },
    { key: "planApproval", floor: "always", attempt: "never", layer: "overrides" },
    { key: "steering", floor: "always", attempt: "elevated", layer: "local" },
    { key: "planApproval", floor: "always", attempt: "never", layer: "local" },
  ] as const)("rejects $key loosening at $layer ($floor → $attempt)", async ({ key, floor, attempt, layer }) => {
    if (layer === "committed") {
      await writeJson(join(home, "factory.json"), { schemaVersion: 1, defaults: { [key]: floor } });
      await writeJson(join(repo, ".pi", "factory.json"), { schemaVersion: 1, [key]: attempt });
    } else if (layer === "overrides") {
      await writeJson(join(home, "factory.json"), {
        schemaVersion: 1,
        repos: [{ path: repo, overrides: { [key]: attempt } }],
      });
      await writeJson(join(repo, ".pi", "factory.json"), { schemaVersion: 1, [key]: floor });
    } else {
      await writeJson(join(repo, ".pi", "factory.json"), { schemaVersion: 1, [key]: floor });
      await writeJson(join(repo, ".pi", "factory.local.json"), { schemaVersion: 1, [key]: attempt });
    }
    const err = await loadEffectiveConfig(repo, { home, defaultBase: trunk }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarrowingError);
    expect((err as NarrowingError).key).toBe(key);
    expect((err as NarrowingError).layer).toBe(layer);
    expect((err as NarrowingError).keyPath).toBe(key);
    expect((err as NarrowingError).message).toBe(
      `config: layer "${layer}" may not loosen "${key}" (${floor} → ${attempt})`,
    );
  });

  it.each([
    { key: "steering", restored: "never" },
    { key: "sandbox", restored: "off" },
  ] as const)("rejects global null-deletion of $key before committed can restore $restored", async ({ key, restored }) => {
    await writeJson(join(home, "factory.json"), { schemaVersion: 1, defaults: { [key]: null } });
    await writeJson(join(repo, ".pi", "factory.json"), { schemaVersion: 1, [key]: restored });
    const err = await loadEffectiveConfig(repo, { home, defaultBase: trunk }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarrowingError);
    expect((err as NarrowingError).key).toBe(key);
    expect((err as NarrowingError).layer).toBe("global");
    expect((err as NarrowingError).keyPath).toBe(key);
    expect((err as NarrowingError).message).toBe(
      `config: layer "global" may not loosen "${key}" (safety keys cannot be deleted with null)`,
    );
  });

  it("rejects committed null-deletion of maxDiffLines before overrides can restore a looser cap", async () => {
    await writeJson(join(repo, ".pi", "factory.json"), { schemaVersion: 1, maxDiffLines: null });
    await writeJson(join(home, "factory.json"), {
      schemaVersion: 1,
      repos: [{ path: repo, overrides: { maxDiffLines: 800 } }],
    });
    const err = await loadEffectiveConfig(repo, { home, defaultBase: trunk }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarrowingError);
    expect((err as NarrowingError).key).toBe("maxDiffLines");
    expect((err as NarrowingError).layer).toBe("committed");
  });

  it.each([
    { winning: "global", values: { global: 2 } },
    { winning: "committed", values: { global: 2, committed: 3 } },
    { winning: "overrides", values: { global: 2, committed: 3, overrides: 4 } },
    { winning: "local", values: { global: 2, committed: 3, overrides: 4, local: 5 } },
  ] as const)("later layer wins when checksConcurrency collides through $winning", async ({ winning, values }) => {
    const expected = values[winning];
    await writeJson(join(home, "factory.json"), {
      schemaVersion: 1,
      ...(values.global !== undefined ? { defaults: { checksConcurrency: values.global } } : {}),
      ...(values.overrides !== undefined
        ? { repos: [{ path: repo, overrides: { checksConcurrency: values.overrides } }] }
        : {}),
    });
    if (values.committed !== undefined) {
      await writeJson(join(repo, ".pi", "factory.json"), {
        schemaVersion: 1,
        checksConcurrency: values.committed,
      });
    }
    if (values.local !== undefined) {
      await writeJson(join(repo, ".pi", "factory.local.json"), {
        schemaVersion: 1,
        checksConcurrency: values.local,
      });
    }
    const cfg = await loadEffectiveConfig(repo, { home, defaultBase: trunk });
    expect(cfg.repo.checksConcurrency).toBe(expected);
    expect(cfg.provenance["repo.checksConcurrency"]).toBe(winning);
  });

  it("refuses null-deleting a key that has a built-in default", async () => {
    await writeJson(join(repo, ".pi", "factory.local.json"), { schemaVersion: 1, checksConcurrency: null });
    const err = await loadEffectiveConfig(repo, { home, defaultBase: trunk }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe("deleted-default");
    expect((err as ConfigError).keyPath).toBe("repo.checksConcurrency");
  });

  it("surfaces file errors from any layer", async () => {
    await writeJson(join(home, "factory.json"), { schemaVersion: 1, defaults: { steerng: "always" } });
    const err = await loadEffectiveConfig(repo, { home, defaultBase: trunk }).catch((e: unknown) => e);
    expect((err as ConfigError).code).toBe("unknown-key");
    expect((err as ConfigError).keyPath).toBe("defaults.steerng");
  });

  it("configSha depends on values only, not on file key order", async () => {
    const local = join(repo, ".pi", "factory.local.json");
    await writeJson(local, { schemaVersion: 1, checksConcurrency: 2, maxChangedFiles: 9 });
    const a = await loadEffectiveConfig(repo, { home, defaultBase: trunk });
    const b = await loadEffectiveConfig(repo, { home, defaultBase: trunk });
    await writeFile(local, '{"maxChangedFiles":9,"checksConcurrency":2,"schemaVersion":1}');
    const c = await loadEffectiveConfig(repo, { home, defaultBase: trunk });
    await writeJson(local, { schemaVersion: 1, checksConcurrency: 3, maxChangedFiles: 9 });
    const d = await loadEffectiveConfig(repo, { home, defaultBase: trunk });
    expect(a.configSha).toBe(b.configSha);
    expect(c.configSha).toBe(a.configSha);
    expect(d.configSha).not.toBe(a.configSha);
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("configSha is equal for identical effective values produced by different layers", async () => {
    await writeJson(join(home, "factory.json"), { schemaVersion: 1, defaults: { checksConcurrency: 2 } });
    const fromGlobal = await loadEffectiveConfig(repo, { home, defaultBase: trunk });

    await writeJson(join(home, "factory.json"), { schemaVersion: 1 });
    await writeJson(join(repo, ".pi", "factory.json"), { schemaVersion: 1, checksConcurrency: 2 });
    const fromCommitted = await loadEffectiveConfig(repo, { home, defaultBase: trunk });

    await writeJson(join(repo, ".pi", "factory.json"), { schemaVersion: 1 });
    await writeJson(join(home, "factory.json"), {
      schemaVersion: 1,
      repos: [{ path: repo, overrides: { checksConcurrency: 2 } }],
    });
    const fromOverrides = await loadEffectiveConfig(repo, { home, defaultBase: trunk });

    await writeJson(join(home, "factory.json"), { schemaVersion: 1 });
    await writeJson(join(repo, ".pi", "factory.local.json"), { schemaVersion: 1, checksConcurrency: 2 });
    const fromLocal = await loadEffectiveConfig(repo, { home, defaultBase: trunk });

    expect(fromGlobal.repo.checksConcurrency).toBe(2);
    expect(fromCommitted.repo.checksConcurrency).toBe(2);
    expect(fromOverrides.repo.checksConcurrency).toBe(2);
    expect(fromLocal.repo.checksConcurrency).toBe(2);
    expect(fromGlobal.configSha).toBe(fromCommitted.configSha);
    expect(fromCommitted.configSha).toBe(fromOverrides.configSha);
    expect(fromOverrides.configSha).toBe(fromLocal.configSha);
    expect(fromGlobal.provenance["repo.checksConcurrency"]).toBe("global");
    expect(fromCommitted.provenance["repo.checksConcurrency"]).toBe("committed");
    expect(fromOverrides.provenance["repo.checksConcurrency"]).toBe("overrides");
    expect(fromLocal.provenance["repo.checksConcurrency"]).toBe("local");
  });
});

describe("resolveDefaultBase", () => {
  it("prefers origin/HEAD, then the checked-out branch, then main", async () => {
    const fx = await makeFixtureRepo();
    try {
      const branch = await git(fx.repo, "symbolic-ref", "--short", "HEAD");
      const remotes = (await git(fx.repo, "remote")).split("\n");
      if (!remotes.includes("origin")) await git(fx.repo, "remote", "add", "origin", fx.bare);
      await git(fx.repo, "fetch", "-q", "origin");
      await git(fx.repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
      expect(await resolveDefaultBase(fx.repo)).toBe(branch);
    } finally {
      await fx.cleanup();
    }

    const unborn = await mkdtemp(join(tmpdir(), "sdlc-nobase-"));
    await git(unborn, "init", "-q", "-b", "devel");
    expect(await resolveDefaultBase(unborn)).toBe("devel");
    await rm(unborn, { recursive: true, force: true });

    const notARepo = await mkdtemp(join(tmpdir(), "sdlc-norepo-"));
    expect(await resolveDefaultBase(notARepo)).toBe("main");
    await rm(notARepo, { recursive: true, force: true });
  });
});
