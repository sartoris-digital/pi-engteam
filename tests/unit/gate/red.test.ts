import { describe, it, expect } from "vitest";
import { verifyRedBaseline } from "../../../src/gate/red.js";
import { junitCaseId, type JunitReport, type JunitStatus } from "../../../src/gate/junit.js";
import type { Workspace } from "../../../src/workspace/types.js";

const ws: Workspace = {
  provider: "git",
  path: "/tmp/ws-red",
  branch: "factory/x",
  baseSha: "0000000",
  repoRoot: "/tmp/repo",
  gitCommonDir: "/tmp/repo/.git",
  configSha: "cfg",
};

function makeReport(entries: Array<[string, string, JunitStatus]>, collectionErrors: string[] = []): JunitReport {
  const cases = entries.map(([classname, name, status]) => ({
    id: junitCaseId(classname, name),
    classname,
    name,
    suite: classname,
    status,
    timeSeconds: 0,
  }));
  const counts = { total: cases.length, passed: 0, failed: 0, error: 0, skipped: 0 };
  for (const c of cases) counts[c.status] += 1;
  return { cases, counts, collectionErrors };
}

const T = "tests/unit/feature.test.ts";

describe("verifyRedBaseline", () => {
  it("is ok when every gate id is present and failed", () => {
    const report = makeReport([
      [T, "AC1 rejects empty input", "failed"],
      [T, "AC2 returns total", "failed"],
      ["tests/unit/other.test.ts", "unrelated passes", "passed"],
    ]);
    const r = verifyRedBaseline(ws, [`${T}::AC1 rejects empty input`, `${T}::AC2 returns total`], report);
    expect(r.ok).toBe(true);
    expect(r.escalate).toBeUndefined();
    expect(r.red).toEqual([`${T}::AC1 rejects empty input`, `${T}::AC2 returns total`]);
    expect(r.green).toEqual([]);
  });

  it("escalates gate-baseline-green when every gate id passes", () => {
    const report = makeReport([[T, "AC1", "passed"], [T, "AC2", "passed"]]);
    const r = verifyRedBaseline(ws, [`${T}::AC1`, `${T}::AC2`], report);
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe("gate-baseline-green");
    expect(r.green).toEqual([`${T}::AC1`, `${T}::AC2`]);
  });

  it("escalates gate-baseline-green when some gate ids pass and names them", () => {
    const report = makeReport([[T, "AC1", "failed"], [T, "AC2", "passed"]]);
    const r = verifyRedBaseline(ws, [`${T}::AC1`, `${T}::AC2`], report);
    expect(r.escalate).toBe("gate-baseline-green");
    expect(r.green).toEqual([`${T}::AC2`]);
    expect(r.detail).toContain(`${T}::AC2`);
  });

  it("escalates gate-invalid on an error status (RED for the wrong reason)", () => {
    const report = makeReport([[T, "AC1", "error"], [T, "AC2", "failed"]]);
    const r = verifyRedBaseline(ws, [`${T}::AC1`, `${T}::AC2`], report);
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe("gate-invalid");
    expect(r.errored).toEqual([`${T}::AC1`]);
  });

  it("escalates gate-invalid on a skipped gate test", () => {
    const report = makeReport([[T, "AC1", "skipped"]]);
    const r = verifyRedBaseline(ws, [`${T}::AC1`], report);
    expect(r.escalate).toBe("gate-invalid");
    expect(r.skipped).toEqual([`${T}::AC1`]);
  });

  it("escalates gate-invalid when a gate id is missing from the report", () => {
    const report = makeReport([[T, "AC1", "failed"]]);
    const r = verifyRedBaseline(ws, [`${T}::AC1`, `${T}::AC9`], report);
    expect(r.escalate).toBe("gate-invalid");
    expect(r.missing).toEqual([`${T}::AC9`]);
    expect(r.detail).toContain("missing");
  });

  it("escalates gate-invalid on a collection error even when gate ids failed", () => {
    const report = makeReport([[T, "AC1", "failed"]], ["tests/unit/broken.test.ts::tests/unit/broken.test.ts"]);
    const r = verifyRedBaseline(ws, [`${T}::AC1`], report);
    expect(r.escalate).toBe("gate-invalid");
    expect(r.detail).toContain("collection");
  });

  it("escalates gate-invalid when no gate ids are declared", () => {
    const r = verifyRedBaseline(ws, [], makeReport([[T, "AC1", "failed"]]));
    expect(r.escalate).toBe("gate-invalid");
  });

  it("normalizes ids given as absolute paths under the workspace and dedupes", () => {
    const report = makeReport([[T, "AC1", "failed"]]);
    const r = verifyRedBaseline(ws, [`${ws.path}/${T}::AC1`, `${T}::AC1`, "  "], report);
    expect(r.ok).toBe(true);
    expect(r.red).toEqual([`${T}::AC1`]);
  });
});
