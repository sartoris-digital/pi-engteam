import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerdict, readVerdictFileOnce, waitForVerdictFile } from "../../../src/runtime/verdict.js";

describe("parseVerdict", () => {
  it("returns the cleaned payload for a valid document", () => {
    const r = parseVerdict(JSON.stringify({ step: "implement", verdict: "PASS", unknown: true, flags: ["x"] }));
    expect(r).toEqual({ ok: true, payload: { step: "implement", verdict: "PASS", flags: ["x"] } });
  });

  it("reports invalid JSON as non-fatal (the file may still be mid-write)", () => {
    const r = parseVerdict('{"step": "impl');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fatal).toBe(false);
      expect(r.error).toMatch(/not valid JSON/);
    }
  });

  it("reports schema violations as fatal with the offending path", () => {
    const r = parseVerdict(JSON.stringify({ step: "implement", verdict: "MAYBE" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fatal).toBe(true);
      expect(r.error).toMatch(/\/verdict/);
    }
  });

  it("rejects non-object documents", () => {
    expect(parseVerdict("[1,2]").ok).toBe(false);
    expect(parseVerdict("null").ok).toBe(false);
  });

  it("rejects documents over the 256 KB cap as fatal", () => {
    const big = JSON.stringify({ step: "implement", verdict: "PASS", issues: ["x".repeat(256 * 1024)] });
    const r = parseVerdict(big);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fatal).toBe(true);
      expect(r.error).toMatch(/exceeds 262144 bytes/);
    }
  });
});

describe("readVerdictFileOnce / waitForVerdictFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-sdlc-verdict-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for a missing file", async () => {
    expect(await readVerdictFileOnce(join(dir, "missing.json"))).toBeNull();
  });

  it("resolves once the file appears", async () => {
    const path = join(dir, "v.json");
    setTimeout(() => void writeFile(path, JSON.stringify({ step: "plan", verdict: "PASS" })), 60);
    const payload = await waitForVerdictFile(path, { signal: new AbortController().signal, pollMs: 10 });
    expect(payload).toEqual({ step: "plan", verdict: "PASS" });
  });

  it("keeps polling over a partially written file", async () => {
    const path = join(dir, "v.json");
    await writeFile(path, '{"step": "plan", "verd');
    setTimeout(() => void writeFile(path, JSON.stringify({ step: "plan", verdict: "FAIL", issues: ["nope"] })), 50);
    const payload = await waitForVerdictFile(path, { signal: new AbortController().signal, pollMs: 10 });
    expect(payload?.verdict).toBe("FAIL");
  });

  it("returns null when the signal aborts before a verdict appears", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const started = Date.now();
    const payload = await waitForVerdictFile(join(dir, "never.json"), { signal: ac.signal, pollMs: 10 });
    expect(payload).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns null immediately for an oversize file", async () => {
    const path = join(dir, "big.json");
    await writeFile(path, "x".repeat(256 * 1024 + 1));
    const payload = await waitForVerdictFile(path, { signal: new AbortController().signal, pollMs: 10 });
    expect(payload).toBeNull();
  });

  it("returns null immediately for a well-formed but invalid document", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify({ verdict: "PASS" }));
    const payload = await waitForVerdictFile(path, { signal: new AbortController().signal, pollMs: 10 });
    expect(payload).toBeNull();
  });
});
