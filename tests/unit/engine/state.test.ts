import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSafeRunId,
  listRuns,
  loadRunState,
  markerLine,
  newRunState,
  readGeneratedJson,
  readRunSecret,
  runDirPath,
  saveRunState,
  stripMarker,
  ulid,
  writeGeneratedJson,
  type NewRunParams,
} from "../../../src/engine/state.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpRunsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sdlc-state-"));
  created.push(dir);
  return dir;
}

function params(over: Partial<NewRunParams> = {}): NewRunParams {
  return {
    workflow: "factory-sdlc:chore@deadbeef",
    lane: "chore",
    kind: "chore",
    tier: "low",
    currentStep: "scope-check",
    ticket: { tracker: "local", ref: "local-1", title: "rename helper" },
    workspaceDir: "/tmp/ws",
    mainCheckout: "/tmp/repo",
    branch: "factory/local-1-rename-helper",
    baseSha: "0000000",
    configSha: "cfg0",
    budget: { fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8, maxIterations: 21 },
    ...over,
  };
}

describe("ulid", () => {
  it("is 26 Crockford base32 chars and sorts by time", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(b).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(ulid(5)).not.toBe(ulid(5)); // random tail differs
    expect(ulid(5).slice(0, 10)).toBe(ulid(5).slice(0, 10)); // same time prefix
  });
});

describe("run ids and markers", () => {
  it("accepts ulids, rejects traversal and _factory", () => {
    expect(isSafeRunId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isSafeRunId("run-1")).toBe(true);
    expect(isSafeRunId("../x")).toBe(false);
    expect(isSafeRunId("")).toBe(false);
    expect(isSafeRunId("_factory")).toBe(false);
    expect(() => runDirPath("/runs", "../x")).toThrow(/unsafe run id/);
    expect(runDirPath("/runs", "run-1")).toBe("/runs/run-1");
  });

  it("marker line matches the contract and stripMarker removes only it", () => {
    expect(markerLine("run-1")).toBe("<!-- pi-sdlc-factory generated · run run-1 · do not commit -->");
    expect(stripMarker(`${markerLine("run-1")}\n{"a":1}\n`)).toBe('{"a":1}\n');
    expect(stripMarker('{"a":1}\n')).toBe('{"a":1}\n');
  });

  it("writeGeneratedJson prefixes the marker and readGeneratedJson strips it", async () => {
    const dir = await tmpRunsDir();
    const path = join(dir, "x.json");
    await writeGeneratedJson(path, "run-1", { a: 1 });
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n")[0]).toBe(markerLine("run-1"));
    expect(await readGeneratedJson<{ a: number }>(path)).toEqual({ a: 1 });
    expect(await readGeneratedJson(join(dir, "missing.json"))).toBeNull();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("newRunState", () => {
  it("creates the run dir tree, a 0600 secret and a marker-prefixed state.json", async () => {
    const runsDir = await tmpRunsDir();
    const state = await newRunState(runsDir, params({ now: () => 1_700_000_000_000 }));
    expect(state.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(state.status).toBe("pending");
    expect(state.currentStep).toBe("scope-check");
    expect(state.iteration).toBe(0);
    expect(state.rounds).toEqual({});
    expect(state.hostCommits).toEqual([]);
    expect(state.wallSecondsUsed).toBe(0);
    expect(state.costUsd).toBe(0);
    expect(state.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(state.startedAt).toBe("2023-11-14T22:13:20.000Z");

    const runDir = runDirPath(runsDir, state.runId);
    expect((await stat(runDir)).mode & 0o777).toBe(0o700);
    for (const sub of ["evidence", "steps", "_verdicts", "human-input", "approvals/pending", "approvals/granted"]) {
      expect((await stat(join(runDir, sub))).isDirectory()).toBe(true);
    }
    const secretStat = await stat(join(runDir, ".secret"));
    expect(secretStat.mode & 0o777).toBe(0o600);
    const secret = await readRunSecret(runDir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const raw = await readFile(join(runDir, "state.json"), "utf8");
    expect(raw.split("\n")[0]).toBe(markerLine(state.runId));
    const loaded = await loadRunState(runsDir, state.runId);
    expect(loaded).toEqual(state);
  });
});

describe("saveRunState / loadRunState", () => {
  it("saves atomically (no tmp files left) and bumps updatedAt", async () => {
    const runsDir = await tmpRunsDir();
    const state = await newRunState(runsDir, params());
    const before = state.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    state.currentStep = "plan";
    state.iteration = 1;
    await saveRunState(runsDir, state);
    const loaded = await loadRunState(runsDir, state.runId);
    expect(loaded?.currentStep).toBe("plan");
    expect(loaded?.iteration).toBe(1);
    expect(loaded?.updatedAt).not.toBe(before);
    const entries = await readdir(runDirPath(runsDir, state.runId));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("returns null for a missing or unsafe run", async () => {
    const runsDir = await tmpRunsDir();
    expect(await loadRunState(runsDir, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    expect(await loadRunState(runsDir, "../etc")).toBeNull();
  });
});

describe("listRuns", () => {
  it("lists only directories that hold a state.json, sorted, excluding _factory", async () => {
    const runsDir = await tmpRunsDir();
    const b = await newRunState(runsDir, params({ now: () => 2_000 }));
    const a = await newRunState(runsDir, params({ now: () => 1_000 }));
    await mkdir(join(runsDir, "_factory"), { recursive: true });
    await writeFile(join(runsDir, "_factory", "state.json"), "{}");
    await mkdir(join(runsDir, "not-a-run"));
    expect(await listRuns(runsDir)).toEqual([a.runId, b.runId]);
    expect(await listRuns(join(runsDir, "does-not-exist"))).toEqual([]);
  });
});
