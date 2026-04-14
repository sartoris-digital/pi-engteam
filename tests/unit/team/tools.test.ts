import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createSendMessageTool } from "../../../src/team/tools/SendMessage.js";
import { createVerdictEmitTool } from "../../../src/team/tools/VerdictEmit.js";
import { createTaskListTool, createTaskUpdateTool } from "../../../src/team/tools/TaskList.js";
import { createRequestApprovalTool } from "../../../src/team/tools/RequestApproval.js";
import { createGrantApprovalTool } from "../../../src/team/tools/GrantApproval.js";
import { MessageBus } from "../../../src/team/MessageBus.js";
import type { VerdictPayload } from "../../../src/types.js";

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), "tools-test-"));
}

describe("SendMessage tool", () => {
  it("calls bus.send with correct fields", async () => {
    const bus = new MessageBus();
    const sent: any[] = [];
    bus.subscribe("reviewer", async (m) => { sent.push(m); });
    const tool = createSendMessageTool(bus, "implementer");
    await tool.execute("call-1", {
      to: "reviewer",
      summary: "implementation done",
      message: "I finished the work",
    }, undefined, undefined, undefined as any);
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("implementer");
    expect(sent[0].to).toBe("reviewer");
    expect(sent[0].summary).toBe("implementation done");
  });
});

describe("VerdictEmit tool", () => {
  it("calls onVerdict with PASS payload", async () => {
    const verdicts: VerdictPayload[] = [];
    const tool = createVerdictEmitTool((v) => { verdicts.push(v); });
    await tool.execute("call-1", { step: "build", verdict: "PASS" }, undefined, undefined, undefined as any);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].verdict).toBe("PASS");
  });

  it("calls onVerdict with FAIL and issues", async () => {
    const verdicts: VerdictPayload[] = [];
    const tool = createVerdictEmitTool((v) => { verdicts.push(v); });
    await tool.execute("call-1", {
      step: "review",
      verdict: "FAIL",
      issues: ["missing error handling in parser"],
    }, undefined, undefined, undefined as any);
    expect(verdicts[0].verdict).toBe("FAIL");
    expect(verdicts[0].issues).toContain("missing error handling in parser");
  });
});

describe("TaskList and TaskUpdate tools", () => {
  it("TaskList returns empty array when no task file exists", async () => {
    const dir = await makeTmpDir();
    const listTool = createTaskListTool(dir, "run-1");
    const result = await listTool.execute("call-1", {}, undefined, undefined, undefined as any);
    const content = JSON.parse((result.content[0] as any).text);
    expect(content).toEqual([]);
  });

  it("TaskUpdate creates and updates a task", async () => {
    const dir = await makeTmpDir();
    const updateTool = createTaskUpdateTool(dir, "run-2");
    await updateTool.execute("call-1", {
      taskId: "task-abc",
      status: "in_progress",
      notes: "started work",
    }, undefined, undefined, undefined as any);
    const listTool = createTaskListTool(dir, "run-2");
    const result = await listTool.execute("call-2", {}, undefined, undefined, undefined as any);
    const tasks = JSON.parse((result.content[0] as any).text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("task-abc");
    expect(tasks[0].status).toBe("in_progress");
  });
});

describe("RequestApproval tool", () => {
  it("writes pending approval file", async () => {
    const dir = await makeTmpDir();
    const tool = createRequestApprovalTool(dir, "run-3");
    const result = await tool.execute("call-1", {
      op: "git-push",
      command: "git push origin main",
      justification: "Merging approved feature branch",
    }, undefined, undefined, undefined as any);
    const text = (result.content[0] as any).text;
    const parsed = JSON.parse(text);
    expect(parsed.requestId).toBeTruthy();
    const { readdir } = await import("fs/promises");
    const files = await readdir(join(dir, "run-3", "approvals", "pending"));
    expect(files).toHaveLength(1);
  });
});

describe("GrantApproval tool", () => {
  it("creates signed token file", async () => {
    const dir = await makeTmpDir();
    const requestTool = createRequestApprovalTool(dir, "run-4");
    const reqResult = await requestTool.execute("call-1", {
      op: "npm-install-new",
      command: "npm install lodash",
      justification: "Need lodash for data processing",
    }, undefined, undefined, undefined as any);
    const { requestId } = JSON.parse((reqResult.content[0] as any).text);
    const grantTool = createGrantApprovalTool(dir, "run-4");
    await grantTool.execute("call-2", { requestId }, undefined, undefined, undefined as any);
    const { readdir } = await import("fs/promises");
    const files = await readdir(join(dir, "run-4", "approvals"));
    const tokenFiles = files.filter(f => f.endsWith(".json") && !f.includes("pending"));
    expect(tokenFiles).toHaveLength(1);
  });
});
