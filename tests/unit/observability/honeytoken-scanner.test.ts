import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scanFile, scanPaths } from "../../../src/observability/honeytoken-scanner.js";

describe("honeytoken-scanner", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "honey-"));
  });

  it("detects a leaked GitHub PAT in a persisted JSONL", () => {
    const p = join(dir, "agent-activity.jsonl");
    writeFileSync(
      p,
      '{"body":"token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0123 leaked"}\n' +
      '{"body":"normal line, no secret"}\n',
    );
    const hits = scanFile(p);
    expect(hits.length).toBe(1);
    expect(hits[0].patternClass).toBe("github-pat-classic");
    // Preview is itself redacted.
    expect(hits[0].preview).toContain("REDACTED");
    expect(hits[0].preview).not.toContain("ghp_AAAA");
  });

  it("returns no hits when all lines are clean", () => {
    const p = join(dir, "clean.jsonl");
    writeFileSync(p, '{"body":"hello world"}\n{"body":"more clean text"}\n');
    expect(scanFile(p)).toEqual([]);
  });

  it("respects maxHitsPerFile", () => {
    const p = join(dir, "many.jsonl");
    const line = '{"body":"key sk-1234567890abcdef1234567890abcdef"}';
    writeFileSync(p, Array(20).fill(line).join("\n"));
    const hits = scanFile(p, { maxHitsPerFile: 5 });
    expect(hits.length).toBe(5);
  });

  it("scanPaths aggregates across files", () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, '{"body":"sk-1234567890abcdef1234567890abcdef"}\n');
    writeFileSync(b, '{"body":"ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0123"}\n');
    const r = scanPaths([a, b]);
    expect(r.filesScanned).toBe(2);
    expect(r.hits.length).toBe(2);
    const classes = r.hits.map((h) => h.patternClass).sort();
    expect(classes).toEqual(["github-pat-classic", "openai-sk"]);
  });

  it("skips files over the size cap and records a scanner-skip-oversize entry", () => {
    const p = join(dir, "huge.jsonl");
    writeFileSync(p, "x".repeat(1024));
    const hits = scanFile(p, { maxBytes: 100 });
    expect(hits.length).toBe(1);
    expect(hits[0].patternClass).toBe("scanner-skip-oversize");
  });
});
