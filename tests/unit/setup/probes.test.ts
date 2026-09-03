import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import {
  probeChecks,
  probeDefaultBranch,
  probeGit,
  probePackageManager,
  probeSandbox,
} from "../../../src/setup/probes.js";
import { probeSandbox as runtimeProbeSandbox } from "../../../src/runtime/sandbox.js";

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
