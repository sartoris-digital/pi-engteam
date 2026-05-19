// tests/unit/approval/phase6-check-approval.test.ts
//
// PLAN.md ApprovalWatcher Phase 6 — CheckApproval tool tests.
//
// Pure-read poll for approval state. Returns one of:
//   pending | granted | denied | not-found | rollback-handoff.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createCheckApprovalTool } from "../../../src/team/tools/CheckApproval.js";
import { createRequestApprovalTool } from "../../../src/team/tools/RequestApproval.js";
import { createGrantApprovalTool } from "../../../src/team/tools/GrantApproval.js";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

async function execCheck(tool: ReturnType<typeof createCheckApprovalTool>, requestId: string) {
  const out = await tool.execute("test-id", { requestId });
  const text = out.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return JSON.parse(text);
}

async function enableWatcherForRun(homeDir: string, runId: string, opts: Partial<{ emergencyStop: boolean }> = {}) {
  const safetyDir = join(homeDir, ".pi", "engineering-team");
  await mkdir(safetyDir, { recursive: true });
  await writeFile(
    join(safetyDir, "safety.json"),
    JSON.stringify({
      approvalWatcher: {
        enabled: true,
        canaryRunIds: [runId],
        emergencyStop: opts.emergencyStop ?? false,
      },
    }),
  );
}

describe("ApprovalWatcher Phase 6 — CheckApproval rollback-handoff gating", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let runsDir: string;
  const runId = "phase6-rb";

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase6-"));
    process.env.HOME = tmpHome;
    runsDir = join(tmpHome, "runs");
    await mkdir(join(runsDir, runId), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("returns rollback-handoff when approvalWatcher.enabled=false", async () => {
    // No safety.json → defaults: enabled=false.
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("rollback-handoff");
    expect(r.reason).toContain("not active");
  });

  it("returns rollback-handoff when run is not in canaryRunIds", async () => {
    await enableWatcherForRun(tmpHome, "OTHER-RUN");
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("rollback-handoff");
  });

  it("allRuns:true bypasses canaryRunIds", async () => {
    const safetyDir = join(tmpHome, ".pi", "engineering-team");
    await mkdir(safetyDir, { recursive: true });
    await writeFile(
      join(safetyDir, "safety.json"),
      JSON.stringify({ approvalWatcher: { enabled: true, allRuns: true } }),
    );
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    // No record on disk → not-found (NOT rollback-handoff).
    expect(r.status).toBe("not-found");
  });
});

describe("ApprovalWatcher Phase 6 — CheckApproval status transitions (watcher active)", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let runsDir: string;
  const runId = "phase6-active";

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase6-active-"));
    process.env.HOME = tmpHome;
    runsDir = join(tmpHome, "runs");
    await mkdir(join(runsDir, runId), { recursive: true });
    await enableWatcherForRun(tmpHome, runId);
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("returns not-found when no record exists", async () => {
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("not-found");
    expect(r.reason).toContain("no pending");
  });

  it("returns not-found for invalid UUID shape", async () => {
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, "../escape");
    expect(r.status).toBe("not-found");
    expect(r.reason).toMatch(/UUID v4/);
  });

  it("returns pending when pending/<id>.json exists", async () => {
    const req = createRequestApprovalTool(runsDir, runId);
    const reqResult = await req.execute("call-1", {
      op: "git-push",
      command: "git push origin main",
      justification: "ship",
    });
    const reqText = (reqResult.content[0] as { text: string }).text;
    const { requestId } = JSON.parse(reqText);
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, requestId);
    expect(r.status).toBe("pending");
    expect(r.requestId).toBe(requestId);
  });

  it("returns granted when a verified token exists for this requestId", async () => {
    const req = createRequestApprovalTool(runsDir, runId);
    const reqResult = await req.execute("call-1", {
      op: "git-push",
      command: "git push origin main",
      justification: "ship",
    });
    const { requestId } = JSON.parse((reqResult.content[0] as { text: string }).text);
    const grant = createGrantApprovalTool(runsDir, runId);
    await grant.execute("call-2", { requestId });
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, requestId);
    expect(r.status).toBe("granted");
    expect(r.tokenId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.scope).toBe("once");
  });

  it("returns pending when only the .granted marker exists (token write window)", async () => {
    // Plant just the .granted file without minting a token.
    const pendingDir = join(runsDir, runId, "approvals", "pending");
    await mkdir(pendingDir, { recursive: true });
    const granted = join(pendingDir, `${VALID_UUID}.json.granted`);
    await writeFile(granted, "{}");
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("pending");
  });

  it("returns denied when quarantine/<id>.json exists", async () => {
    const quarantineDir = join(runsDir, runId, "approvals", "quarantine");
    await mkdir(quarantineDir, { recursive: true });
    await writeFile(
      join(quarantineDir, `${VALID_UUID}.json`),
      JSON.stringify({ reason: "schema-invalid" }),
    );
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("denied");
    expect(r.reason).toBe("schema-invalid");
  });

  it("returns denied with reason=emergency-stop when emergencyStop=true", async () => {
    await enableWatcherForRun(tmpHome, runId, { emergencyStop: true });
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("denied");
    expect(r.reason).toBe("emergency-stop");
  });

  it("does NOT count an expired token as granted", async () => {
    // Mint a properly-signed token with ttlSeconds:0 so the signature
    // covers a past expiresAt — exercises the verified-expired branch.
    const req = createRequestApprovalTool(runsDir, runId);
    const reqResult = await req.execute("call-1", { op: "bash", command: "echo", justification: "j" });
    const { requestId } = JSON.parse((reqResult.content[0] as { text: string }).text);
    const grant = createGrantApprovalTool(runsDir, runId);
    await grant.execute("call-2", { requestId, ttlSeconds: 0 });
    // Wait long enough that Date.now() > expiresAt.
    await new Promise((r) => setTimeout(r, 50));

    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, requestId);
    expect(r.status).toBe("denied");
    expect(r.reason).toBe("expired");
    expect(r.tokenId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does NOT match a token whose requestId differs", async () => {
    // Mint a token for one request, then ask about a DIFFERENT requestId.
    const req = createRequestApprovalTool(runsDir, runId);
    const reqResult = await req.execute("call-1", { op: "bash", command: "echo a", justification: "j" });
    const { requestId } = JSON.parse((reqResult.content[0] as { text: string }).text);
    const grant = createGrantApprovalTool(runsDir, runId);
    await grant.execute("call-2", { requestId });
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID); // unrelated UUID
    expect(r.status).toBe("not-found");
  });

  it("is pure-read: state.json + safety.json mtimes unchanged after check", async () => {
    const safetyPath = join(tmpHome, ".pi", "engineering-team", "safety.json");
    const beforeMtime = (await import("fs/promises")).stat(safetyPath).then((s) => s.mtimeMs);
    const tool = createCheckApprovalTool(runsDir, runId);
    await execCheck(tool, VALID_UUID);
    const afterMtime = (await import("fs/promises")).stat(safetyPath).then((s) => s.mtimeMs);
    expect(await afterMtime).toBe(await beforeMtime);
  });

  // Phase 6 review fixes — both rounds HIGH + MEDIUM regression tests.

  it("emergency-stop takes precedence over rollback-handoff (review HIGH, both rounds)", async () => {
    // emergencyStop=true AND enabled=false (rollback eligible). The
    // previous code returned rollback-handoff; the fix ensures the
    // global stop denies unconditionally.
    const safetyDir = join(tmpHome, ".pi", "engineering-team");
    await mkdir(safetyDir, { recursive: true });
    await writeFile(
      join(safetyDir, "safety.json"),
      JSON.stringify({ approvalWatcher: { enabled: false, emergencyStop: true } }),
    );
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("denied");
    expect(r.reason).toBe("emergency-stop");
  });

  it("emergency-stop also wins when run is not on the canary list", async () => {
    const safetyDir = join(tmpHome, ".pi", "engineering-team");
    await mkdir(safetyDir, { recursive: true });
    await writeFile(
      join(safetyDir, "safety.json"),
      JSON.stringify({
        approvalWatcher: {
          enabled: true,
          canaryRunIds: ["DIFFERENT-RUN"],
          emergencyStop: true,
        },
      }),
    );
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("denied");
    expect(r.reason).toBe("emergency-stop");
  });

  it("caps and sanitizes quarantine reason (review MEDIUM, both rounds)", async () => {
    const quarantineDir = join(runsDir, runId, "approvals", "quarantine");
    await mkdir(quarantineDir, { recursive: true });
    // Reason with embedded NUL + escape sequence + 1000-char filler.
    const hostile = "ANSI\x1b[31mRED\x00null" + "x".repeat(1000);
    await writeFile(
      join(quarantineDir, `${VALID_UUID}.json`),
      JSON.stringify({ reason: hostile }),
    );
    const tool = createCheckApprovalTool(runsDir, runId);
    const r = await execCheck(tool, VALID_UUID);
    expect(r.status).toBe("denied");
    // Control chars stripped, length bounded.
    expect(r.reason).not.toContain("\x00");
    expect(r.reason).not.toContain("\x1b");
    expect(r.reason.length).toBeLessThanOrEqual(201); // 200 + ellipsis char
  });
});
