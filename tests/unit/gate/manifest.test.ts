import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { recordManifest, verifyManifestUnchanged, countSkipMarkers, SKIP_MARKER_PATTERNS } from "../../../src/gate/manifest.js";
import type { Workspace } from "../../../src/workspace/types.js";

function wsFor(path: string): Workspace {
  return { provider: "git", path, branch: "main", baseSha: "", repoRoot: path, gitCommonDir: join(path, ".git"), configSha: "" };
}

const TEST_DIR = "spec-tests";
const INFRA = ["spec.config.*"];
const TEST_FILE = "spec-tests/alpha.test.ts";
const TEST_SRC = `import { it, expect } from "vitest";\nit("AC1 alpha", () => { expect(1).toBe(2); });\n`;

let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
let ws: Workspace;

beforeEach(async () => {
  fx = await makeFixtureRepo();
  ws = wsFor(fx.repo);
  await mkdir(join(fx.repo, TEST_DIR), { recursive: true });
  await mkdir(join(fx.repo, "lib"), { recursive: true });
  await writeFile(join(fx.repo, TEST_FILE), TEST_SRC, "utf8");
  await writeFile(join(fx.repo, "spec.config.ts"), "export default {};\n", "utf8");
  await writeFile(join(fx.repo, "lib/alpha.ts"), "export const alpha = 1;\n", "utf8");
});

afterEach(async () => {
  await fx.cleanup();
});

describe("countSkipMarkers", () => {
  it("counts js and python skip/only markers", () => {
    const text = `it.skip("a", () => {});\ndescribe.only("b", () => {});\n@pytest.mark.xfail\ndef test_x(): pass\ntest.skip("c")\n`;
    expect(countSkipMarkers(text)).toBe(4);
    expect(countSkipMarkers(`it("skips nothing", () => {});\nconst skip = 1;\n`)).toBe(0);
    expect(SKIP_MARKER_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("recordManifest", () => {
  it("hashes only testDir files and testInfra matches, and records skip marker counts", async () => {
    const m = await recordManifest(ws, TEST_DIR, INFRA, { collectedCount: 7 });
    expect(Object.keys(m.files).sort()).toEqual([TEST_FILE, "spec.config.ts"]);
    expect(m.files[TEST_FILE]).toMatch(/^[0-9a-f]{64}$/);
    expect(m.skipMarkers).toEqual({ [TEST_FILE]: 0, "spec.config.ts": 0 });
    expect(m.collectedCount).toBe(7);
    expect(m.testDir).toBe(TEST_DIR);
    expect(m.testInfra).toEqual(INFRA);
  });

  it("defaults collectedCount to 0 (not measured)", async () => {
    const m = await recordManifest(ws, TEST_DIR, INFRA);
    expect(m.collectedCount).toBe(0);
  });
});

describe("verifyManifestUnchanged", () => {
  it("is ok when the test tree is untouched even if product code changed", async () => {
    const m = await recordManifest(ws, TEST_DIR, INFRA);
    await writeFile(join(fx.repo, "lib/alpha.ts"), "export const alpha = 2;\n", "utf8");
    const r = await verifyManifestUnchanged(ws, m, { testChanges: [] });
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual([]);
    expect(r.escalate).toBeUndefined();
  });

  it("fails without escalation on an undeclared test edit", async () => {
    const m = await recordManifest(ws, TEST_DIR, INFRA);
    await writeFile(join(fx.repo, TEST_FILE), TEST_SRC.replace("toBe(2)", "toBe(1)"), "utf8");
    const r = await verifyManifestUnchanged(ws, m, { testChanges: [] });
    expect(r.ok).toBe(false);
    expect(r.escalate).toBeUndefined();
    expect(r.reason).toBe("undeclared-test-changes");
    expect(r.changed).toEqual([TEST_FILE]);
    expect(r.undeclared).toEqual([TEST_FILE]);
  });

  it("accepts a declared edit by exact path or glob", async () => {
    const m = await recordManifest(ws, TEST_DIR, INFRA);
    await writeFile(join(fx.repo, TEST_FILE), TEST_SRC.replace("toBe(2)", "toBe(1)"), "utf8");
    await writeFile(join(fx.repo, "spec-tests/beta.test.ts"), `it("AC2 beta", () => {});\n`, "utf8");
    const exact = await verifyManifestUnchanged(ws, m, { testChanges: [TEST_FILE, "spec-tests/beta.test.ts"] });
    expect(exact.ok).toBe(true);
    expect(exact.changed).toEqual(["spec-tests/alpha.test.ts", "spec-tests/beta.test.ts"]);
    const glob = await verifyManifestUnchanged(ws, m, { testChanges: ["spec-tests/**"] });
    expect(glob.ok).toBe(true);
  });

  it("treats testInfra edits and deleted test files as changes", async () => {
    const m = await recordManifest(ws, TEST_DIR, INFRA);
    await writeFile(join(fx.repo, "spec.config.ts"), "export default { test: { include: [] } };\n", "utf8");
    await rm(join(fx.repo, TEST_FILE));
    const r = await verifyManifestUnchanged(ws, m, { testChanges: [] });
    expect(r.ok).toBe(false);
    expect(r.undeclared).toEqual([TEST_FILE, "spec.config.ts"]);
  });

  it("escalates test-tampering when a skip/only marker is added, even if declared", async () => {
    const m = await recordManifest(ws, TEST_DIR, INFRA);
    await writeFile(join(fx.repo, TEST_FILE), TEST_SRC.replace('it("AC1', 'it.skip("AC1'), "utf8");
    const r = await verifyManifestUnchanged(ws, m, { testChanges: [TEST_FILE] });
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe("test-tampering");
    expect(r.reason).toBe("skip-markers-added");
    expect(r.newSkipMarkers).toEqual([{ path: TEST_FILE, before: 0, after: 1 }]);
  });

  it("does not flag a pre-existing marker that was already in the manifest", async () => {
    await writeFile(join(fx.repo, TEST_FILE), TEST_SRC.replace('it("AC1', 'it.skip("AC1'), "utf8");
    const m = await recordManifest(ws, TEST_DIR, INFRA);
    expect(m.skipMarkers[TEST_FILE]).toBe(1);
    await writeFile(join(fx.repo, TEST_FILE), TEST_SRC.replace('it("AC1', 'it.skip("AC1').replace("toBe(2)", "toBe(1)"), "utf8");
    const r = await verifyManifestUnchanged(ws, m, { testChanges: [TEST_FILE] });
    expect(r.ok).toBe(true);
    expect(r.newSkipMarkers).toEqual([]);
  });

  it("escalates test-tampering when the collected count decreases", async () => {
    const m = await recordManifest(ws, TEST_DIR, INFRA, { collectedCount: 10 });
    const down = await verifyManifestUnchanged(ws, m, { testChanges: [], collectedCount: 9 });
    expect(down.ok).toBe(false);
    expect(down.escalate).toBe("test-tampering");
    expect(down.reason).toBe("collected-count-decreased");
    expect(down.collectedBefore).toBe(10);
    expect(down.collectedAfter).toBe(9);
    expect((await verifyManifestUnchanged(ws, m, { testChanges: [], collectedCount: 10 })).ok).toBe(true);
    expect((await verifyManifestUnchanged(ws, m, { testChanges: [], collectedCount: 12 })).ok).toBe(true);
    expect((await verifyManifestUnchanged(ws, m, { testChanges: [] })).ok).toBe(true);
  });
});
