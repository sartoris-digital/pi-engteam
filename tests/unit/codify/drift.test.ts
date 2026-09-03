import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendSealedRetryFixture,
  applyDrift,
  detectDrift,
  onSourceMemberReverted,
  retryFailingCase,
} from "../../../src/codify/drift.js";
import { sealedDir } from "../../../src/codify/layout.js";
import { matchTools } from "../../../src/codify/matcher.js";
import {
  emptyRegistry,
  transition,
  type Registry,
  type RegistryEntry,
} from "../../../src/codify/registry.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function sha(label: string): string {
  return label.padEnd(64, "0").slice(0, 64);
}

function entry(over: Partial<RegistryEntry> & Pick<RegistryEntry, "name" | "state">): RegistryEntry {
  return {
    version: 1,
    class: "stage-tool",
    scope: "repo",
    repo: "acme/app",
    toolSha256: sha("tool"),
    manifestSha256: sha("man"),
    skillSha256: sha("skl"),
    judgedSha: sha("jdg"),
    validation: { baseSha: sha("base"), uvVersion: "0.4.0", formatterVersion: "3.1.0" },
    secretsBound: true,
    landedAs: "clean",
    matcher: { titlePatterns: ["chore: bump .+ to .+"], planStepPatterns: [], pathGlobs: ["package.json"] },
    writeGlobs: ["package.json"],
    readGlobs: ["package.json"],
    stats: {
      exact: 0,
      partial: 0,
      shadowAgree: 2,
      shadowDisagree: 0,
      preconditionRefusals: 0,
      failures: 0,
      recentHits: [],
      savedUsd: 0,
      savedWallSeconds: 0,
    },
    history: [],
    ...over,
  };
}

function registryOf(...entries: RegistryEntry[]): Registry {
  const reg = emptyRegistry();
  for (const e of entries) reg.entries[e.name] = e;
  return reg;
}

const baseDrift = {
  executingSha256: sha("tool"),
  registrySha256: sha("tool"),
  preconditionStreak: 0,
  writeGlobs: ["package.json"],
  writeRoots: ["package.json", "src/**"],
  uvVersion: "0.4.0",
  formatterVersion: "3.1.0",
  validation: { uvVersion: "0.4.0", formatterVersion: "3.1.0" },
};

describe("detectDrift", () => {
  it("triggers on each drift class", () => {
    expect(detectDrift(baseDrift)).toEqual({ drifted: false });
    expect(detectDrift({ ...baseDrift, executingSha256: sha("other") })).toEqual({
      drifted: true,
      trigger: "sha-mismatch",
    });
    expect(detectDrift({ ...baseDrift, smoke: { exitCode: 3 } })).toEqual({
      drifted: true,
      trigger: "smoke-fail",
    });
    expect(detectDrift({ ...baseDrift, smoke: { exitCode: 0, applyOk: false } })).toEqual({
      drifted: true,
      trigger: "smoke-fail",
    });
    expect(detectDrift({ ...baseDrift, smoke: { exitCode: 0, applyOk: true, checksRed: true } })).toEqual({
      drifted: true,
      trigger: "smoke-fail",
    });
    expect(detectDrift({ ...baseDrift, preconditionStreak: 3 })).toEqual({
      drifted: true,
      trigger: "precondition-streak",
    });
    expect(detectDrift({ ...baseDrift, writeGlobs: ["tests/secret.ts"], writeRoots: ["src/**"] })).toEqual({
      drifted: true,
      trigger: "write-globs-outside-roots",
    });
    expect(detectDrift({ ...baseDrift, uvVersion: "1.0.0" })).toEqual({
      drifted: true,
      trigger: "major-tooling-bump",
    });
    expect(detectDrift({ ...baseDrift, formatterVersion: "4.0.0" })).toEqual({
      drifted: true,
      trigger: "major-tooling-bump",
    });
    expect(detectDrift({ ...baseDrift, uvVersion: "0.5.0" })).toEqual({ drifted: false });
  });
});

describe("applyDrift", () => {
  it("marks drifted and excludes the tool from matching until re-validation", () => {
    const reg = registryOf(entry({ name: "bump", state: "active" }));
    const next = applyDrift(reg, "bump", "sha-mismatch", NOW);
    expect(next.entries.bump?.state).toBe("drifted");
    expect(next.entries.bump?.history.at(-1)).toMatchObject({
      from: "active",
      to: "drifted",
      by: "system",
      reason: "sha-mismatch",
    });
    const query = { title: "chore: bump pkg to 1.3.0", likelyPaths: ["package.json"] };
    expect(matchTools([next.entries.bump!], query).matches).toEqual([]);
    expect(matchTools([entry({ name: "bump", state: "demoted" })], query).matches).toEqual([]);
    expect(matchTools([entry({ name: "bump", state: "retired" })], query).matches).toEqual([]);
    const revalidated = transition(next, "bump", "probationary", "system", "re-validate", NOW);
    expect(matchTools([revalidated.entries.bump!], query).matches).toHaveLength(1);
  });
});

describe("retryFailingCase", () => {
  it("appends a sealed fixture and does not mutate tool.py; repair enqueues when replay still fails", async () => {
    await withTmpHome(async (home) => {
      const name = "bump-package-version";
      const toolPy = "print('stable')\n";
      const toolPath = join(home, "codified", "tools", name, "tool.py");
      await mkdir(join(home, "codified", "tools", name), { recursive: true, mode: 0o700 });
      await writeFile(toolPath, toolPy, "utf8");
      const failing = { input: { version: "9.9.9" }, expectedPatch: "diff --git a/package.json b/package.json\n" };
      const result = retryFailingCase({
        toolPy,
        failing,
        revalidate: () => ({ ok: false }),
      });
      expect(result.toolPy).toBe(toolPy);
      expect(result.enqueueRepair).toBe(true);
      expect(result.sealedFixture).toEqual(failing);
      const dest = await appendSealedRetryFixture({ home, name, ...failing });
      expect(dest.startsWith(sealedDir(home, name))).toBe(true);
      expect(await readFile(join(dest, "expected.patch"), "utf8")).toBe(failing.expectedPatch);
      expect(JSON.parse(await readFile(join(dest, "input.json"), "utf8"))).toEqual(failing.input);
      expect(await readFile(toolPath, "utf8")).toBe(toolPy);
    });
  });

  it("does not enqueue repair when the new sealed fixture now passes", () => {
    const toolPy = "print('ok')\n";
    const result = retryFailingCase({
      toolPy,
      failing: { input: { version: "1.2.3" }, expectedPatch: "p" },
      revalidate: () => ({ ok: true }),
    });
    expect(result.enqueueRepair).toBe(false);
    expect(result.toolPy).toBe(toolPy);
  });
});

describe("onSourceMemberReverted", () => {
  it("drops an active tool to probationary after a source member revert", () => {
    const e = onSourceMemberReverted(entry({ name: "bump", state: "active" }), NOW);
    expect(e.state).toBe("probationary");
    expect(e.history.at(-1)).toMatchObject({
      from: "active",
      to: "probationary",
      by: "system",
      reason: "survival-reverted",
    });
  });
});
