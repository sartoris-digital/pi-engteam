import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { installStubPath } from "../../helpers/install-stub-path.js";
import {
  probeAz,
  probeChecks,
  probeDefaultBranch,
  probeGit,
  probeJira,
  probePackageManager,
  probeSandbox,
} from "../../../src/setup/probes.js";
import { probeSandbox as runtimeProbeSandbox } from "../../../src/runtime/sandbox.js";
import { createFakeCli, createPathCli } from "../../../src/trackers/host-cli.js";

describe("probeGit", () => {
  it("reports remotes for a real repo and ok=false for a plain directory", async () => {
    const fx = await makeFixtureRepo();
    try {
      const probe = await probeGit(fx.repo);
      expect(probe.ok).toBe(true);
      expect(probe.repoRoot).toBe(fx.repo);
      expect(probe.remotes.some((r) => r.name === "origin" && r.url.includes("remote.git"))).toBe(true);
    } finally {
      await fx.cleanup();
    }
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-notgit-"));
    try {
      expect(await probeGit(dir)).toEqual({ ok: false, repoRoot: dir, remotes: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("probeDefaultBranch", () => {
  it("reads origin/HEAD from the fixture (main)", async () => {
    const fx = await makeFixtureRepo();
    try {
      expect(await probeDefaultBranch(fx.repo)).toEqual({ branch: "main", source: "origin-head" });
    } finally {
      await fx.cleanup();
    }
  });
});

describe("probePackageManager", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-sdlc-pm-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers pnpm-lock.yaml, then yarn, bun, npm", async () => {
    expect(await probePackageManager(dir)).toEqual({ manager: "none", lockfile: null });
    await writeFile(join(dir, "package-lock.json"), "{}\n");
    expect(await probePackageManager(dir)).toEqual({ manager: "npm", lockfile: "package-lock.json" });
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    expect(await probePackageManager(dir)).toEqual({ manager: "pnpm", lockfile: "pnpm-lock.yaml" });
  });
});

describe("probeChecks", () => {
  it("infers a vitest junit check from package.json and stays empty otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-checks-"));
    try {
      expect(await probeChecks(dir)).toEqual({ checks: [] });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ devDependencies: { vitest: "^2.1.0" }, scripts: { test: "vitest run" } }),
      );
      const probe = await probeChecks(dir);
      expect(probe.checks).toHaveLength(1);
      expect(probe.checks[0]).toMatchObject({
        name: "vitest",
        reporter: "junit",
        junitPath: "reports/junit.xml",
      });
      expect(probe.checks[0]?.argv).toContain("vitest");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("probeSandbox re-export", () => {
  it("is the runtime probe, not a second implementation", () => {
    expect(probeSandbox).toBe(runtimeProbeSandbox);
  });
});

describe("probeAz / probeJira", () => {
  it("reports available on canned FakeCli stdout and never throws", async () => {
    const az = createFakeCli(() => ({ stdout: JSON.stringify({ id: "sub", name: "Test" }), stderr: "", code: 0 }));
    const jira = createFakeCli(() => ({
      stdout: JSON.stringify({ accountId: "ada", emailAddress: "ada@example.com" }),
      stderr: "",
      code: 0,
    }));
    await expect(probeAz(az)).resolves.toEqual({ available: true });
    await expect(probeJira(jira)).resolves.toEqual({ available: true });
  });

  it("returns available:false with a reason on fail-auth and on thrown cli errors", async () => {
    const fail = createFakeCli(() => ({ stdout: "", stderr: "stub: az auth failed (fail-auth)", code: 1 }));
    const az = await probeAz(fail);
    expect(az.available).toBe(false);
    expect(az.reason).toMatch(/fail-auth|exited 1/);
    const boom = createFakeCli(() => {
      throw new Error("spawn az ENOENT");
    });
    const thrown = await probeAz(boom);
    expect(thrown.available).toBe(false);
    expect(thrown.reason).toMatch(/ENOENT/);
  });

  it("reports available on the stub PATH and false under fail-auth", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-probe-az-")));
    try {
      const installed = await installStubPath(home);
      const ok = createPathCli(installed.env);
      expect(await probeAz(ok)).toEqual({ available: true });
      expect(await probeJira(ok)).toEqual({ available: true });
      const denied = createPathCli({ ...installed.env, PI_SDLC_STUB_SCENARIO: "fail-auth" });
      const az = await probeAz(denied);
      const jira = await probeJira(denied);
      expect(az.available).toBe(false);
      expect(az.reason?.length).toBeGreaterThan(0);
      expect(jira.available).toBe(false);
      expect(jira.reason?.length).toBeGreaterThan(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
