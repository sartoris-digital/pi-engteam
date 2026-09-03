import { describe, it, expect } from "vitest";
import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  FACTORY_HOME_ENV,
  GENERATED_MARKER_RE,
  RUN_ID_RE,
  RUN_SUBDIRS,
  assertRunId,
  ensureDirs,
  ensureRunDir,
  factoryHome,
  generatedMarker,
  runDir,
  runsDir,
} from "../../../src/home.js";
import { makeTmpHome, withTmpHome } from "../../helpers/tmp-home.js";

describe("factoryHome", () => {
  it("honours PI_SDLC_HOME and resolves it to an absolute path", () => {
    expect(factoryHome({ PI_SDLC_HOME: "/tmp/x/factory" })).toBe("/tmp/x/factory");
    expect(factoryHome({ PI_SDLC_HOME: "rel/home" })).toBe(resolve("rel/home"));
  });

  it("falls back to ~/.pi/sdlc-factory when unset or blank", () => {
    const expected = join(homedir(), ".pi", "sdlc-factory");
    expect(factoryHome({})).toBe(expected);
    expect(factoryHome({ PI_SDLC_HOME: "   " })).toBe(expected);
    expect(FACTORY_HOME_ENV).toBe("PI_SDLC_HOME");
  });
});

describe("runsDir / runDir", () => {
  it("joins under the given home", () => {
    expect(runsDir("/h")).toBe("/h/runs");
    expect(runDir("run-01_ab", "/h")).toBe("/h/runs/run-01_ab");
  });

  it("rejects run ids that could escape the runs dir or collide with _factory", () => {
    for (const bad of ["", "../x", "a/b", ".hidden", "-lead", "_factory", "x".repeat(129), "sp ace"]) {
      expect(() => assertRunId(bad), bad).toThrow(/invalid runId/);
      expect(() => runDir(bad, "/h"), bad).toThrow(/invalid runId/);
    }
    expect(RUN_ID_RE.test("01J8ZK3Q9V0H")).toBe(true);
  });
});

describe("ensureDirs / ensureRunDir", () => {
  it("creates the state layout with owner-only permissions", async () => {
    await withTmpHome(async (home) => {
      const dirs = await ensureDirs(home);
      expect(dirs).toEqual({
        home,
        runs: join(home, "runs"),
        factoryRuns: join(home, "runs", "_factory"),
        worktrees: join(home, "worktrees"),
        policy: join(home, "policy"),
        bin: join(home, "bin"),
      });
      for (const d of Object.values(dirs)) {
        expect((await stat(d)).isDirectory(), d).toBe(true);
      }
      expect((await stat(dirs.runs)).mode & 0o077).toBe(0);
      // idempotent
      await expect(ensureDirs(home)).resolves.toEqual(dirs);
    });
  });

  it("creates the one per-run subdirectory list the engine also uses", async () => {
    await withTmpHome(async (home) => {
      expect([...RUN_SUBDIRS]).toEqual([
        "steps",
        "evidence",
        "approvals/pending",
        "approvals/granted",
        "_verdicts",
        "human-input",
        "checks",
        "scripts",
      ]);
      const r = await ensureRunDir("run1", home);
      const base = join(home, "runs", "run1");
      expect(r).toEqual({
        runDir: base,
        steps: join(base, "steps"),
        evidence: join(base, "evidence"),
        approvalsPending: join(base, "approvals", "pending"),
        approvalsGranted: join(base, "approvals", "granted"),
        verdicts: join(base, "_verdicts"),
        humanInput: join(base, "human-input"),
        checks: join(base, "checks"),
        scripts: join(base, "scripts"),
      });
      for (const d of Object.values(r)) {
        expect((await stat(d)).isDirectory(), d).toBe(true);
      }
      await expect(ensureRunDir("../evil", home)).rejects.toThrow(/invalid runId/);
    });
  });
});

describe("generatedMarker", () => {
  it("renders the locked marker line and the regex accepts it", () => {
    const line = generatedMarker("run_42");
    expect(line).toBe("<!-- pi-sdlc-factory generated · run run_42 · do not commit -->");
    expect(GENERATED_MARKER_RE.test(line)).toBe(true);
    expect(GENERATED_MARKER_RE.test("<!-- something else -->")).toBe(false);
  });
});

describe("tmp-home helper", () => {
  it("sets PI_SDLC_HOME for the callback and restores it afterwards", async () => {
    const before = process.env[FACTORY_HOME_ENV];
    process.env[FACTORY_HOME_ENV] = "/previous/value";
    try {
      let seen = "";
      const home = await withTmpHome(async (h) => {
        seen = process.env[FACTORY_HOME_ENV] ?? "";
        expect(factoryHome()).toBe(h);
        return h;
      });
      expect(seen).toBe(home);
      expect(process.env[FACTORY_HOME_ENV]).toBe("/previous/value");
      await expect(stat(home)).rejects.toThrow();
    } finally {
      if (before === undefined) delete process.env[FACTORY_HOME_ENV];
      else process.env[FACTORY_HOME_ENV] = before;
    }
  });

  it("makeTmpHome cleanup is idempotent", async () => {
    const t = await makeTmpHome();
    expect((await stat(join(t.home, "runs", "_factory"))).isDirectory()).toBe(true);
    await t.cleanup();
    await t.cleanup();
    await expect(stat(t.home)).rejects.toThrow();
  });

  it("makeTmpHome restores PI_SDLC_HOME even if the tree is already gone", async () => {
    const before = process.env[FACTORY_HOME_ENV];
    process.env[FACTORY_HOME_ENV] = "/previous/value";
    try {
      const t = await makeTmpHome();
      await rm(t.home, { recursive: true, force: true });
      await t.cleanup();
      expect(process.env[FACTORY_HOME_ENV]).toBe("/previous/value");
      await t.cleanup();
    } finally {
      if (before === undefined) delete process.env[FACTORY_HOME_ENV];
      else process.env[FACTORY_HOME_ENV] = before;
    }
  });
});
