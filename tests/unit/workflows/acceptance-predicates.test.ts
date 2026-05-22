import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultArtifactPredicate, passThrough } from "../../../src/workflows/acceptance-predicates.js";
import type { VerdictPayload } from "../../../src/types.js";

function makeVerdict(over: Partial<VerdictPayload> = {}): VerdictPayload {
  return {
    step: over.step ?? "classify",
    verdict: over.verdict ?? "PASS",
    artifacts: over.artifacts ?? ["triage-summary.md"],
    issues: over.issues,
    handoffHint: over.handoffHint,
  } as VerdictPayload;
}

describe("defaultArtifactPredicate", () => {
  let runDir: string;
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "accept-pred-"));
  });

  it("passes when an artifact exists under runDir with non-zero bytes", async () => {
    writeFileSync(join(runDir, "triage-summary.md"), "## Decisions\n- Severity: P1\n");
    const pred = defaultArtifactPredicate();
    const r = await pred({ verdict: makeVerdict(), runDir, stepName: "classify" });
    expect(r.ok).toBe(true);
  });

  it("fails when an artifact is missing on disk", async () => {
    const pred = defaultArtifactPredicate();
    const r = await pred({ verdict: makeVerdict(), runDir, stepName: "classify" });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/does not exist/);
  });

  it("fails when artifact is empty", async () => {
    writeFileSync(join(runDir, "triage-summary.md"), "");
    const pred = defaultArtifactPredicate();
    const r = await pred({ verdict: makeVerdict(), runDir, stepName: "classify" });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/empty/);
  });

  it("checks required sections in markdown headings", async () => {
    writeFileSync(join(runDir, "triage-summary.md"), "Just a paragraph, no headings.\n");
    const pred = defaultArtifactPredicate({ requiredSections: ["Decisions"] });
    const r = await pred({ verdict: makeVerdict(), runDir, stepName: "classify" });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((m) => /Decisions/.test(m))).toBe(true);
  });

  it("passes when required section is present", async () => {
    writeFileSync(join(runDir, "triage-summary.md"), "## Decisions\n- foo\n");
    const pred = defaultArtifactPredicate({ requiredSections: ["Decisions"] });
    const r = await pred({ verdict: makeVerdict(), runDir, stepName: "classify" });
    expect(r.ok).toBe(true);
  });

  it("refuses synthesized verdicts on safety-gating steps", async () => {
    writeFileSync(join(runDir, "triage-summary.md"), "## Decisions\n- foo\n");
    const pred = defaultArtifactPredicate();
    const r = await pred({
      verdict: makeVerdict(),
      runDir,
      stepName: "judge-gate",
      synthesized: true,
      safetyGating: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/non-authoritative/);
  });

  it("does not refuse synthesized verdicts on non-safety-gating steps", async () => {
    writeFileSync(join(runDir, "triage-summary.md"), "## Decisions\n- foo\n");
    const pred = defaultArtifactPredicate();
    const r = await pred({
      verdict: makeVerdict(),
      runDir,
      stepName: "classify",
      synthesized: true,
      safetyGating: false,
    });
    expect(r.ok).toBe(true);
  });

  it("short-circuits on non-PASS verdicts", async () => {
    const pred = defaultArtifactPredicate();
    const r = await pred({
      verdict: makeVerdict({ verdict: "FAIL" }),
      runDir,
      stepName: "classify",
    });
    expect(r.ok).toBe(true);
  });

  it("resolves absolute artifact paths without prepending runDir", async () => {
    const absPath = join(runDir, "abs-artifact.md");
    writeFileSync(absPath, "## Decisions\n- foo\n");
    const pred = defaultArtifactPredicate();
    const r = await pred({
      verdict: makeVerdict({ artifacts: [absPath] }),
      runDir,
      stepName: "classify",
    });
    expect(r.ok).toBe(true);
  });
});

describe("passThrough", () => {
  it("always returns ok=true", async () => {
    const r = await passThrough({
      verdict: makeVerdict({ verdict: "FAIL" }),
      runDir: "/nonexistent",
      stepName: "any",
    });
    expect(r.ok).toBe(true);
  });
});
