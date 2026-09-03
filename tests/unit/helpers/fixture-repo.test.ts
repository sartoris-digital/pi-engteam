import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

    const r = await runFixtureCheck(fx.repo, check, { home: fx.isolatedHome });
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

  it("fixtureEnv allowlists the child environment and isolates HOME/XDG/git", () => {
    const env = fixtureEnv(
      {
        PATH: "/usr/bin",
        HOME: "/h",
        VITEST: "true",
        VITEST_WORKER_ID: "1",
        VITE_X: "1",
        NODE_OPTIONS: "--x",
        AWS_SECRET_ACCESS_KEY: "secret",
        GH_TOKEN: "gho_x",
        GIT_DIR: "/evil.git",
        GIT_WORK_TREE: "/evil-wt",
        GIT_INDEX_FILE: "/evil/index",
        GIT_CONFIG_GLOBAL: "/evil/config",
        XDG_CONFIG_HOME: "/evil-xdg",
      },
      { home: "/iso" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/iso");
    expect(env.XDG_CONFIG_HOME).toBe(join("/iso", ".config"));
    expect(env.XDG_CACHE_HOME).toBe(join("/iso", ".cache"));
    expect(env.XDG_DATA_HOME).toBe(join("/iso", ".local", "share"));
    expect(env.XDG_STATE_HOME).toBe(join("/iso", ".local", "state"));
    expect(env.TMPDIR).toBe(join("/iso", "tmp"));
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.LC_ALL).toBe("C");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.VITEST).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).not.toBe("/evil-xdg");
  });

  it("ignores injected secrets, GIT redirection, and a hostile global gitconfig", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-fx-outside-")));
    const saved: Record<string, string | undefined> = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      GH_TOKEN: process.env.GH_TOKEN,
    };
    try {
      await mkdir(join(outside, "redirect.git"), { recursive: true });
      const evilConfig = join(outside, "evil.gitconfig");
      const pwned = join(outside, "pwned");
      await writeFile(
        evilConfig,
        `[core]\n\talias.pwn = !touch ${pwned}\n[init]\n\ttemplateDir = ${join(outside, "template")}\n`,
      );
      const sentinel = join(outside, "sentinel.txt");
      await writeFile(sentinel, "SAFE\n");

      process.env.GIT_DIR = join(outside, "redirect.git");
      process.env.GIT_WORK_TREE = outside;
      process.env.GIT_INDEX_FILE = join(outside, "index");
      process.env.GIT_CONFIG_GLOBAL = evilConfig;
      process.env.AWS_SECRET_ACCESS_KEY = "AKIA_TEST_SECRET";
      process.env.GH_TOKEN = "gho_test";

      const other = await makeFixtureRepo();
      try {
        expect(other.isolatedHome.startsWith(other.root)).toBe(true);
        expect((await other.git(["rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true");
        expect((await other.git(["rev-parse", "--show-toplevel"])).stdout.trim()).toBe(other.repo);
        expect((await other.git(["log", "--format=%s"])).stdout.trim()).toBe("chore: initial fixture");
        expect(await readFile(sentinel, "utf8")).toBe("SAFE\n");
        await expect(stat(pwned)).rejects.toThrow();
        const child = fixtureEnv(process.env, { home: other.isolatedHome });
        expect(child.GIT_DIR).toBeUndefined();
        expect(child.GIT_WORK_TREE).toBeUndefined();
        expect(child.GIT_INDEX_FILE).toBeUndefined();
        expect(child.GIT_CONFIG_GLOBAL).toBe("/dev/null");
        expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(child.GH_TOKEN).toBeUndefined();
        expect(child.HOME).toBe(other.isolatedHome);
      } finally {
        await other.cleanup();
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("cleanup removes the whole temp tree", async () => {
    const other = await makeFixtureRepo();
    expect((await stat(other.repo)).isDirectory()).toBe(true);
    await other.cleanup();
    await other.cleanup();
    await expect(stat(other.root)).rejects.toThrow();
  });
});
