import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import {
  auditTranscript,
  hostTranscriptAudit,
  shouldEscalateAudit,
  type AuditFinding,
  type AuditInput,
} from "../../../src/v3/transcript-audit.js";

async function loadFixture(name: string): Promise<AuditInput> {
  const path = fileURLToPath(new URL(`../audit/fixtures/${name}.json`, import.meta.url));
  const raw = JSON.parse(await readFile(path, "utf8")) as AuditInput;
  return raw;
}

function cfg(enabled: boolean) {
  return { v3: { ...DEFAULT_V3_POLICY, transcriptAudit: { enabled } } };
}

describe("auditTranscript", () => {
  it("returns no findings for clean implementer events", async () => {
    const input = await loadFixture("clean");
    expect(auditTranscript(input)).toEqual([]);
  });

  it("flags an undeclared conftest.py write", async () => {
    const input = await loadFixture("conftest-write");
    const findings = auditTranscript(input);
    expect(
      findings.some((f: AuditFinding) => f.rule === "undeclared-test-infra" && f.path === "tests/conftest.py"),
    ).toBe(true);
  });

  it("flags monkeypatch/mock of src/ from a test file", async () => {
    const input = await loadFixture("src-mock");
    const findings = auditTranscript(input);
    expect(findings.some((f: AuditFinding) => f.rule === "src-mock")).toBe(true);
  });

  it("flags new skip/xfail/.only markers", async () => {
    const input = await loadFixture("skip-only");
    const findings = auditTranscript(input);
    expect(findings.some((f: AuditFinding) => f.rule === "skip-marker")).toBe(true);
  });

  it("flags test-id strings hardcoded in src/", async () => {
    const input = await loadFixture("src-testid");
    const findings = auditTranscript(input);
    expect(findings.some((f: AuditFinding) => f.rule === "src-testid" && f.path === "src/login.ts")).toBe(true);
  });
});

describe("shouldEscalateAudit", () => {
  it("is false when the flag is off even if findings are nonempty", async () => {
    const findings = auditTranscript(await loadFixture("conftest-write"));
    expect(findings.length).toBeGreaterThan(0);
    expect(shouldEscalateAudit(cfg(false), findings)).toBe(false);
    expect(shouldEscalateAudit({}, findings)).toBe(false);
  });

  it("is true only when the flag is on and findings are nonempty", async () => {
    const findings = auditTranscript(await loadFixture("conftest-write"));
    expect(shouldEscalateAudit(cfg(true), findings)).toBe(true);
    expect(shouldEscalateAudit(cfg(true), [])).toBe(false);
  });
});

describe("hostTranscriptAudit", () => {
  it("may scan when the flag is off but never escalates", async () => {
    const host = hostTranscriptAudit(cfg(false), await loadFixture("conftest-write"));
    expect(host.findings.length).toBeGreaterThan(0);
    expect(host.escalate).toBe(false);
    expect(host.code).toBeUndefined();
  });

  it("escalates test-tampering when the flag is on", async () => {
    const host = hostTranscriptAudit(cfg(true), await loadFixture("conftest-write"));
    expect(host.escalate).toBe(true);
    expect(host.code).toBe("test-tampering");
  });
});

describe("codify isolation", () => {
  it("does not import the transcript scanner from src/codify", async () => {
    const miner = await readFile(fileURLToPath(new URL("../../../src/codify/miner.ts", import.meta.url)), "utf8");
    expect(miner).not.toMatch(/transcript-audit|auditTranscript/);
  });
});
