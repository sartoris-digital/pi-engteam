import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CohortRegistry, OVERFLOW_COHORT } from "../../../src/observability/cohort-registry.js";

describe("CohortRegistry", () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cohort-"));
  });

  it("assigns a new cohort id on first sight + reuses it on subsequent calls", () => {
    const r = new CohortRegistry(configDir);
    const id1 = r.cohortFor({ provider: "p", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    const id2 = r.cohortFor({ provider: "p", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^c[0-9a-f]{3}$/);
  });

  it("assigns distinct ids for distinct tuples", () => {
    const r = new CohortRegistry(configDir);
    const a = r.cohortFor({ provider: "p1", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    const b = r.cohortFor({ provider: "p2", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    expect(a).not.toBe(b);
  });

  it("returns overflow once maxBuckets is exceeded", () => {
    const r = new CohortRegistry(configDir, { maxBuckets: 2 });
    r.cohortFor({ provider: "p1", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    r.cohortFor({ provider: "p2", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    const o = r.cohortFor({ provider: "p3", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    expect(o).toBe(OVERFLOW_COHORT);
    expect(r.isOverflowing()).toBe(true);
  });

  it("persists across process restart (new instance reads existing file)", () => {
    const r1 = new CohortRegistry(configDir);
    r1.cohortFor({ provider: "p", modelId: "m", accountFingerprint: "a", piVersion: "v1" });
    r1.cohortFor({ provider: "p", modelId: "m", accountFingerprint: "a", piVersion: "v2" });
    const r2 = new CohortRegistry(configDir);
    expect(r2.size()).toBe(2);
    // Same tuple → same id across instances.
    const id = r2.cohortFor({ provider: "p", modelId: "m", accountFingerprint: "a", piVersion: "v1" });
    const r3 = new CohortRegistry(configDir);
    const id2 = r3.cohortFor({ provider: "p", modelId: "m", accountFingerprint: "a", piVersion: "v1" });
    expect(id).toBe(id2);
  });

  it("list() returns every allocated entry", () => {
    const r = new CohortRegistry(configDir);
    r.cohortFor({ provider: "p1", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    r.cohortFor({ provider: "p2", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    const list = r.list();
    expect(list.length).toBe(2);
    expect(list[0].firstSeenTs).toBeDefined();
  });

  it("creates the registry file on first allocation", () => {
    const r = new CohortRegistry(configDir);
    r.cohortFor({ provider: "p", modelId: "m", accountFingerprint: "a", piVersion: "v" });
    expect(existsSync(join(configDir, "cohort-registry.json"))).toBe(true);
  });
});
