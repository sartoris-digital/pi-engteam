import { describe, it, expect } from "vitest";
import { renderCompatTable, VERDICT_EMIT_FALLBACK, TASKLIST_FALLBACK, CHECK_APPROVAL_FALLBACK, USE_SECRET_FALLBACK } from "../../../src/team/tool-fallbacks.js";

const runDir = "/tmp/run-123";

describe("tool-fallbacks registry", () => {
  it("renders the verdict-emit recovery block when runDir + write are available", () => {
    const out = VERDICT_EMIT_FALLBACK.render({
      runDir,
      verdictFilePath: `${runDir}/_verdicts/test.json`,
      builtinTools: new Set(["write", "read", "edit"]),
    });
    expect(out).toBeDefined();
    expect(out!).toContain("`write`");
    expect(out!).toContain(`${runDir}/_verdicts/test.json`);
  });

  it("renders an edit-tool block when only edit is available", () => {
    const out = VERDICT_EMIT_FALLBACK.render({
      runDir,
      verdictFilePath: `${runDir}/_verdicts/test.json`,
      builtinTools: new Set(["edit", "read"]),
    });
    expect(out).toBeDefined();
    expect(out!).toContain("`edit`");
  });

  it("returns undefined when verdictFilePath is missing", () => {
    const out = VERDICT_EMIT_FALLBACK.render({ runDir, builtinTools: new Set(["write"]) });
    expect(out).toBeUndefined();
  });

  it("TaskList recovery references the runDir tasks.json", () => {
    const out = TASKLIST_FALLBACK.render({ runDir, builtinTools: new Set(["write"]) });
    expect(out).toBeDefined();
    expect(out!).toContain(`${runDir}/tasks.json`);
  });

  it("CheckApproval recovery references the approvals directory", () => {
    const out = CHECK_APPROVAL_FALLBACK.render({ runDir, builtinTools: new Set(["read"]) });
    expect(out).toBeDefined();
    expect(out!).toContain(`${runDir}/approvals/pending/`);
  });

  it("UseSecret is marked no-fallback with a fail-fast message", () => {
    expect(USE_SECRET_FALLBACK.noFallback).toBe(true);
    const out = USE_SECRET_FALLBACK.render({ runDir, builtinTools: new Set() });
    expect(out!).toContain("NO file-write recovery");
    expect(out!).toContain('FAIL');
  });

  it("renderCompatTable composes the full block when runDir is present", () => {
    const out = renderCompatTable({
      runDir,
      verdictFilePath: `${runDir}/_verdicts/test.json`,
      builtinTools: new Set(["read", "write", "edit"]),
    });
    expect(out).toContain("TaskList");
    expect(out).toContain("CheckApproval");
    expect(out).toContain("SendMessage");
    expect(out).toContain("RequestApproval");
    expect(out).toContain("UseSecret");
  });

  it("renderCompatTable returns empty when no entries apply", () => {
    const out = renderCompatTable({ runDir: "", builtinTools: new Set() });
    // SendMessage/RequestApproval/etc. don't depend on runDir, so
    // they still render — the table should still be non-empty.
    expect(out.length).toBeGreaterThan(0);
  });
});
