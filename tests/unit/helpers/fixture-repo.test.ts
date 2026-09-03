import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  fixtureEnv,
  makeFixtureRepo,
  runFixtureCheck,
  type FixtureFactoryJson,
  type FixtureRepo,
} from "../../helpers/fixture-repo.js";

describe("fixture-repo", () => {
  let fx: FixtureRepo;

  beforeAll(async () => {
    fx = await makeFixtureRepo();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("has exactly one initial commit containing the expected files and a clean tree", async () => {
    const log = await fx.git(["log", "--format=%H %s"]);
    expect(log.code).toBe(0);
    const lines = log.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${fx.baseSha} chore: initial fixture`);
    expect(fx.baseSha).toMatch(/^[0-9a-f]{40}$/);

    const files = (await fx.git(["ls-files"])).stdout.trim().split("\n").sort();
    expect(files).toEqual([
      ".gitignore",
      ".pi/factory.json",
      "CHANGELOG.md",
      "package.json",
      "src/index.ts",
      "tests/smoke.test.ts",
    ]);
    expect((await fx.git(["status", "--porcelain"])).stdout).toBe("");
    expect((await fx.git(["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
    expect(fx.defaultBranch).toBe("main");
  });

  it("has origin set to the bare remote with main pushed and origin/HEAD resolved", async () => {
    expect((await fx.git(["remote", "get-url", "origin"])).stdout.trim()).toBe(fx.bare);
    expect((await fx.git(["rev-parse", "origin/main"])).stdout.trim()).toBe(fx.baseSha);
    expect((await fx.git(["rev-parse", "HEAD"], { cwd: fx.bare })).stdout.trim()).toBe(fx.baseSha);
    expect((await fx.git(["rev-parse", "--is-bare-repository"], { cwd: fx.bare })).stdout.trim()).toBe("true");
    expect((await fx.git(["symbolic-ref", "refs/remotes/origin/HEAD"])).stdout.trim()).toBe(
      "refs/remotes/origin/main",
    );
  });

  it("reports non-zero exits instead of throwing", async () => {
    const r = await fx.git(["rev-parse", "--verify", "refs/heads/does-not-exist"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("fatal");
  });

  it("commits a .pi/factory.json whose junit check runs green in the repo", async () => {
    const cfg = JSON.parse(await readFile(join(fx.repo, ".pi", "factory.json"), "utf8")) as FixtureFactoryJson;
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.testDir).toBe("tests");
    const check = cfg.checks[0];
    expect(check).toBeDefined();
    if (!check) return;
    expect(check.reporter).toBe("junit");
    expect(check.junitPath).toBe("reports/junit.xml");
    expect(check.argv[0]).toBe("node");
    expect(check.argv).toContain("--globals");
    expect(check.argv).toContain("--reporter=junit");

    const r = await runFixtureCheck(fx.repo, check);
    expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);

    const xml = await readFile(join(fx.repo, check.junitPath), "utf8");
    expect(xml).toContain("<testsuites");
    expect(xml).toMatch(/failures="0"/);
    expect(xml).toContain('classname="tests/smoke.test.ts"');
    expect(xml).toContain('name="smoke: add"');
    expect(xml).toContain('name="smoke: greet"');
    // report and cache output are ignored, so the working tree stays clean
    expect((await fx.git(["status", "--porcelain"])).stdout).toBe("");
  });

  it("fixtureEnv strips the parent vitest environment", () => {
    const env = fixtureEnv({ PATH: "/usr/bin", VITEST: "true", VITEST_WORKER_ID: "1", VITE_X: "1", NODE_OPTIONS: "--x", HOME: "/h" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  });

  it("cleanup removes the whole temp tree", async () => {
    const other = await makeFixtureRepo();
    expect((await stat(other.repo)).isDirectory()).toBe(true);
    await other.cleanup();
    await other.cleanup();
    await expect(stat(other.root)).rejects.toThrow();
  });
});
