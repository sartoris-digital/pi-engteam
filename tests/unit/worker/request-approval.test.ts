import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  REQUEST_APPROVAL_TOOL_NAME,
  createRequestApprovalTool,
  pendingApprovalPath,
} from "../../../src/worker/request-approval.js";

const ctx = {} as unknown as ExtensionContext;

describe("RequestApproval tool", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "pi-sdlc-approval-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function tool(newId = () => "11111111-2222-4333-8444-555555555555") {
    return createRequestApprovalTool({
      runDir,
      runId: "run-a1",
      stage: "implement",
      agent: "implementer",
      now: () => new Date("2026-09-02T10:00:00.000Z"),
      newId,
    });
  }

  it("is registered under the contract name with op/command/justification parameters", () => {
    const t = tool();
    expect(t.name).toBe(REQUEST_APPROVAL_TOOL_NAME);
    expect(Object.keys(t.parameters.properties)).toEqual(["op", "command", "justification"]);
  });

  it("writes a 0600 pending record and returns the request id", async () => {
    const result = await tool().execute("c1", { op: "git-stash", command: "git stash push", justification: "need a clean tree" }, undefined, undefined, ctx);
    expect(result.details).toEqual({ requestId: "11111111-2222-4333-8444-555555555555" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: 'Approval request 11111111-2222-4333-8444-555555555555 recorded for git-stash. Now call VerdictEmit with verdict "NEEDS_MORE" and flags ["approval-needed"].',
    });
    const path = pendingApprovalPath(runDir, "11111111-2222-4333-8444-555555555555");
    expect(path).toBe(join(runDir, "approvals", "pending", "11111111-2222-4333-8444-555555555555.json"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      _marker: "<!-- pi-sdlc-factory generated · run run-a1 · do not commit -->",
      requestId: "11111111-2222-4333-8444-555555555555",
      runId: "run-a1",
      stage: "implement",
      agent: "implementer",
      op: "git-stash",
      command: "git stash push",
      justification: "need a clean tree",
      requestedAt: "2026-09-02T10:00:00.000Z",
    });
  });

  it("never overwrites an existing request id", async () => {
    const t = tool();
    await t.execute("c1", { op: "a", command: "b", justification: "c" }, undefined, undefined, ctx);
    await expect(t.execute("c2", { op: "a", command: "b", justification: "c" }, undefined, undefined, ctx)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("generates distinct uuids by default", async () => {
    const t = createRequestApprovalTool({ runDir, runId: "run-a1", stage: "implement", agent: "implementer" });
    const a = await t.execute("c1", { op: "a", command: "b", justification: "c" }, undefined, undefined, ctx);
    const b = await t.execute("c2", { op: "a", command: "b", justification: "c" }, undefined, undefined, ctx);
    expect(a.details.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.details.requestId).not.toBe(b.details.requestId);
  });
});
