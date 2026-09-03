import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/config/json.js";
import { signRecord, verifyRecord } from "../../../src/safety/evidence-sign.js";

const SECRET = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const RECORD = { stage: "implement", verdict: "PASS", b: 2, a: 1 };

describe("signRecord / verifyRecord", () => {
  it("returns 64 hex chars and accepts an untouched record", () => {
    const sig = signRecord(RECORD, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRecord(RECORD, sig, SECRET)).toBe(true);
    expect(verifyRecord({ a: 1, b: 2, stage: "implement", verdict: "PASS" }, sig, SECRET)).toBe(true);
  });

  it("is stable under key reordering because it uses config canonicalJson", () => {
    expect(signRecord({ b: 1, a: 2 }, SECRET)).toBe(signRecord({ a: 2, b: 1 }, SECRET));
    expect(signRecord(RECORD, SECRET)).not.toBe(canonicalJson(RECORD));
  });

  it("rejects a wrong secret, a mutated record, and a malformed signature", () => {
    const sig = signRecord(RECORD, SECRET);
    expect(verifyRecord(RECORD, sig, OTHER)).toBe(false);
    expect(verifyRecord({ ...RECORD, verdict: "FAIL" }, sig, SECRET)).toBe(false);
    expect(verifyRecord(RECORD, sig.slice(0, 63), SECRET)).toBe(false);
    expect(verifyRecord(RECORD, "z".repeat(64), SECRET)).toBe(false);
    expect(verifyRecord(RECORD, sig.toUpperCase(), SECRET)).toBe(false);
  });
});
