import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evidencePath,
  listEvidence,
  readEvidence,
  verifyEvidence,
  writeEvidence,
  type EvidenceRecord,
} from "../../../src/engine/evidence.js";
import { markerLine } from "../../../src/engine/state.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECRET = "ab".repeat(32);
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpRunDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "sdlc-evidence-"));
  created.push(base);
  const runDir = join(base, RUN_ID);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  return runDir;
}

function record(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    stage: "implement",
    round: 0,
    agent: "implementer",
    verdict: "PASS",
    predicates: [{ name: "snapshot", ok: true }],
    artifacts: [{ path: "/tmp/ws/src/a.ts", sha256: "00" }],
    commands: [{ argv: ["pnpm", "test"], exitCode: 0, durationMs: 12, outputTail: "ok" }],
    synthesized: [],
    timedOut: false,
    headSha: "abc123",
    at: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

describe("evidence", () => {
  it("names files stage-<stage>-r<round>.json", () => {
    expect(evidencePath("/runs/r1", "scope-check", 2)).toBe("/runs/r1/evidence/stage-scope-check-r2.json");
  });

  it("rejects stage names with separators or traversal and never writes outside evidence/", async () => {
    for (const stage of ["../../victim", "foo/bar", "..", "a\\b", "stage/../../victim", "", ".", "foo.bar"]) {
      expect(() => evidencePath("/runs/R", stage, 0), stage).toThrow(/unsafe evidence stage/);
    }
    const runDir = await tmpRunDir();
    await expect(writeEvidence(runDir, record({ stage: "../../victim" }), SECRET)).rejects.toThrow(/unsafe evidence stage/);
    await expect(stat(join(dirname(runDir), "victim-r0.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a marker-prefixed record plus a .sig, both 0600", async () => {
    const runDir = await tmpRunDir();
    const path = await writeEvidence(runDir, record(), SECRET);
    expect(path).toBe(join(runDir, "evidence", "stage-implement-r0.json"));
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n")[0]).toBe(markerLine(RUN_ID));
    const sig = await readFile(`${path.slice(0, -".json".length)}.sig`, "utf8");
    expect(sig.split("\n")[0]).toBe(markerLine(RUN_ID));
    expect(sig.split("\n")[1]).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("readEvidence returns the record, latest round when round is omitted", async () => {
    const runDir = await tmpRunDir();
    await writeEvidence(runDir, record({ round: 0 }), SECRET);
    await writeEvidence(runDir, record({ round: 2, verdict: "FAIL" }), SECRET);
    await writeEvidence(runDir, record({ stage: "scope-check", round: 0, agent: "host:scope-check" }), SECRET);
    expect((await readEvidence(runDir, "implement", 0))?.verdict).toBe("PASS");
    expect((await readEvidence(runDir, "implement"))?.round).toBe(2);
    expect((await readEvidence(runDir, "scope-check"))?.agent).toBe("host:scope-check");
    expect(await readEvidence(runDir, "judge")).toBeNull();
    expect(await listEvidence(runDir)).toEqual([
      { stage: "implement", round: 0, path: evidencePath(runDir, "implement", 0) },
      { stage: "implement", round: 2, path: evidencePath(runDir, "implement", 2) },
      { stage: "scope-check", round: 0, path: evidencePath(runDir, "scope-check", 0) },
    ]);
  });

  it("verifyEvidence accepts an untouched record and rejects a tampered one", async () => {
    const runDir = await tmpRunDir();
    const path = await writeEvidence(runDir, record(), SECRET);
    expect(await verifyEvidence(runDir, "implement", 0, SECRET)).toEqual({ ok: true, record: record() });
    expect((await verifyEvidence(runDir, "implement", 0, "cd".repeat(32))).ok).toBe(false);

    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace('"verdict": "PASS"', '"verdict": "FAIL"'));
    const tampered = await verifyEvidence(runDir, "implement", 0, SECRET);
    expect(tampered.ok).toBe(false);
    expect(tampered.reason).toBe("signature mismatch");
    expect(tampered.record?.verdict).toBe("FAIL");
  });

  it("reports a missing record or signature", async () => {
    const runDir = await tmpRunDir();
    expect(await verifyEvidence(runDir, "judge", 0, SECRET)).toEqual({ ok: false, record: null, reason: "missing record" });
    const path = await writeEvidence(runDir, record({ stage: "judge" }), SECRET);
    await rm(`${path.slice(0, -".json".length)}.sig`);
    expect((await verifyEvidence(runDir, "judge", 0, SECRET)).reason).toBe("missing signature");
  });
});
