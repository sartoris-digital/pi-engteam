import { describe, expect, it } from "vitest";
import type { RunContext } from "../../../src/safety/context.js";
import { READ_ONLY_STAGE_CLASSES, READ_ONLY_TOOLS, readOnlyBlock, stageClassOf } from "../../../src/safety/layer-b.js";
import { fakePathEnv, fakeRunContext } from "../../helpers/run-context.js";

const env = fakePathEnv();
const reviewer = fakeRunContext({ agent: "reviewer", stage: "review" });
const B = (tool: string, input: Record<string, unknown>, c: RunContext = reviewer) => readOnlyBlock(tool, input, c, env);

describe("stage classes", () => {
  it("lists the read-only roster and fails closed for unknown agents", () => {
    for (const a of ["issue-analyst", "planner", "architect", "reviewer", "security-auditor", "judge", "verifier", "root-cause-debugger", "discoverer", "codebase-cartographer"]) {
      expect(READ_ONLY_STAGE_CLASSES.has(a), a).toBe(true);
      expect(stageClassOf(a), a).toBe("read-only");
    }
    for (const a of ["tester", "implementer", "codifier"]) {
      expect(READ_ONLY_STAGE_CLASSES.has(a), a).toBe(false);
      expect(stageClassOf(a), a).toBe("writer");
    }
    expect(stageClassOf("unknown-agent")).toBe("read-only");
    expect([...READ_ONLY_TOOLS].sort()).toEqual(["RequestApproval", "VerdictEmit", "find", "glob", "grep", "ls", "read"]);
  });
});

describe("read-only agents", () => {
  it("allows the read tools and the worker tools", () => {
    for (const tool of READ_ONLY_TOOLS) expect(B(tool, { path: "src/a.ts" }), tool).toBeNull();
    expect(B("VerdictEmit", { step: "review", verdict: "PASS" })).toBeNull();
  });

  it("allows write/edit only into the run dir", () => {
    expect(B("write", { path: `${reviewer.runDir}/review.md`, content: "" })).toBeNull();
    expect(B("edit", { path: `${reviewer.runDir}/notes/a.md`, edits: [] })).toBeNull();
    const outside = B("write", { path: "src/a.ts", content: "" });
    expect(outside?.layer).toBe("B");
    expect(outside?.terminate).toBeUndefined();
    expect(outside?.reason).toMatch(/^\[Layer B\] read-only stage "review" \(reviewer\)/);
    expect(B("write", { path: `${reviewer.workspaceDir}/src/a.ts`, content: "" })?.layer).toBe("B");
    expect(B("edit", { path: `${reviewer.runDir}/../run-0002/x`, edits: [] })?.layer).toBe("B");
    expect(B("write", { content: "" })?.layer).toBe("B");
  });

  it("allows only safe bash", () => {
    expect(B("bash", { command: "git status && cat src/a.ts" })).toBeNull();
    expect(B("bash", { command: "pnpm test" })).toBeNull();
    const block = B("bash", { command: "git commit -m x" });
    expect(block?.layer).toBe("B");
    expect(block?.reason).toMatch(/commit/);
    expect(B("bash", { command: "echo x > src/a.ts" })?.layer).toBe("B");
    expect(B("bash", {})?.layer).toBe("B");
  });

  it("blocks unknown tools", () => {
    expect(B("some_custom_tool", {})?.layer).toBe("B");
    expect(B("powershell", { command: "ls" })?.layer).toBe("B");
  });

  it("applies to every read-only agent, including the judge", () => {
    const judge = fakeRunContext({ agent: "judge", stage: "judge" });
    expect(B("write", { path: "src/a.ts", content: "" }, judge)?.layer).toBe("B");
    expect(B("write", { path: `${judge.runDir}/verdict.md`, content: "" }, judge)).toBeNull();
  });
});

describe("writer agents", () => {
  it("are not gated by Layer B", () => {
    const implementer = fakeRunContext();
    expect(B("write", { path: "src/a.ts", content: "" }, implementer)).toBeNull();
    expect(B("bash", { command: "git commit -m x" }, implementer)).toBeNull();
    expect(B("some_custom_tool", {}, implementer)).toBeNull();
  });
});
