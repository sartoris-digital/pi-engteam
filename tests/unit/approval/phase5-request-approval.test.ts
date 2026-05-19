// tests/unit/approval/phase5-request-approval.test.ts
//
// PLAN.md ApprovalWatcher Phase 5 — RequestApproval updates:
//   - ensureApprovalsLayout integration (Phase 3 helper)
//   - per-run admission lock for the scan+write critical section
//   - duplicate collapse on (op + argsHash + step + iteration)
//   - per-run pending cap with TOCTOU-safe enforcement under the lock
//   - payload metadata stamping (schemaVersion, issuedAt*, argsHash)
//   - atomic write via <id>.json.tmp → rename
//   - pollHint field on response

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createRequestApprovalTool } from "../../../src/team/tools/RequestApproval.js";
import { createRunState, saveRunState } from "../../../src/adw/RunState.js";

async function execTool(tool: ReturnType<typeof createRequestApprovalTool>, params: { op: string; command: string; justification: string }) {
  // The defineTool surface returns a record; execute is the production entry.
  const out = await tool.execute("test-id", params);
  const text = out.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return JSON.parse(text);
}

describe("ApprovalWatcher Phase 5 — RequestApproval atomic write + metadata", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let runsDir: string;
  const runId = "phase5-test";

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase5-"));
    process.env.HOME = tmpHome;
    runsDir = join(tmpHome, "runs");
    await mkdir(join(runsDir, runId), { recursive: true });
    // Seed a run state so RequestApproval can stamp issuedAtStep/issuedAtIteration.
    const state = await createRunState({
      runId,
      workflow: "plan-build-review",
      goal: "phase5 test",
      budget: {},
    });
    state.currentStep = "build";
    state.iteration = 2;
    await saveRunState(runsDir, state);
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("writes a pending file with full v1 metadata", async () => {
    const tool = createRequestApprovalTool(runsDir, runId);
    const result = await execTool(tool, {
      op: "git-push",
      command: "git push origin main",
      justification: "ship phase 5",
    });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pollHint).toBe("next_tool_call");

    const pendingDir = join(runsDir, runId, "approvals", "pending");
    const files = (await readdir(pendingDir)).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
    const raw = await readFile(join(pendingDir, files[0]), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.runId).toBe(runId);
    expect(parsed.op).toBe("git-push");
    expect(parsed.command).toBe("git push origin main");
    expect(parsed.argsHash).toMatch(/^[a-f0-9]+$/);
    expect(parsed.issuedAtStepName).toBe("build");
    expect(parsed.issuedAtIteration).toBe(2);
    expect(parsed.issuedAtNonce).toMatch(/^[a-f0-9]{16}$/);
    expect(parsed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // File mode is 0o600 per the atomic-write contract.
    expect((await stat(join(pendingDir, files[0]))).mode & 0o777).toBe(0o600);
  });

  it("no .tmp file is left behind after a successful write", async () => {
    const tool = createRequestApprovalTool(runsDir, runId);
    await execTool(tool, {
      op: "bash",
      command: "rm -rf /tmp/junk",
      justification: "cleanup",
    });
    const pendingDir = join(runsDir, runId, "approvals", "pending");
    const tmps = (await readdir(pendingDir)).filter((n) => n.endsWith(".tmp"));
    expect(tmps).toHaveLength(0);
  });

  it("duplicate collapse: same op+command+step+iteration returns the same requestId", async () => {
    const tool = createRequestApprovalTool(runsDir, runId);
    const a = await execTool(tool, {
      op: "git-push",
      command: "git push origin main",
      justification: "first",
    });
    const b = await execTool(tool, {
      op: "git-push",
      command: "git push origin main",
      justification: "second-attempt",
    });
    expect(b.requestId).toBe(a.requestId);
    expect(b.status).toBe("duplicate-of-existing");
    const pendingDir = join(runsDir, runId, "approvals", "pending");
    const files = (await readdir(pendingDir)).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
  });

  it("per-run pending cap: 101st write returns refused per-run-pending-cap", async () => {
    // Lower the cap via safety.json so the test runs in milliseconds.
    const safetyDir = join(tmpHome, ".pi", "engineering-team");
    await mkdir(safetyDir, { recursive: true });
    await writeFile(
      join(safetyDir, "safety.json"),
      JSON.stringify({ approvalWatcher: { maxPendingPerRun: 3 } }),
      "utf8",
    );
    const tool = createRequestApprovalTool(runsDir, runId);
    // Vary the command so each call writes a fresh row (no dedup).
    for (let i = 0; i < 3; i++) {
      const r = await execTool(tool, {
        op: "bash",
        command: `echo ${i}`,
        justification: "cap test",
      });
      expect(r.requestId).toBeTruthy();
    }
    const fourth = await execTool(tool, {
      op: "bash",
      command: "echo 4",
      justification: "should refuse",
    });
    expect(fourth.refused).toBe("per-run-pending-cap");
    expect(fourth.requestId).toBeUndefined();
  });

  it("clamps oversized command + justification", async () => {
    const tool = createRequestApprovalTool(runsDir, runId);
    const oversize = "x".repeat(4097);
    const a = await execTool(tool, { op: "bash", command: oversize, justification: "ok" });
    expect(a.error).toMatch(/command must be 1\.\.4096/);
    const b = await execTool(tool, { op: "bash", command: "ok", justification: oversize });
    expect(b.error).toMatch(/justification must be <= 4096/);
  });

  it("refuses when approvals layout is unsafe (Phase 3 integration)", async () => {
    // Plant a symlink at approvals/ so ensureApprovalsLayout returns symlink-detected.
    const decoy = join(tmpHome, "decoy");
    await mkdir(decoy, { recursive: true });
    const { symlink } = await import("fs/promises");
    await symlink(decoy, join(runsDir, runId, "approvals"));
    const tool = createRequestApprovalTool(runsDir, runId);
    const r = await execTool(tool, {
      op: "git-push",
      command: "git push origin main",
      justification: "should refuse",
    });
    expect(r.error).toMatch(/approvals layout unsafe: symlink-detected/);
  });

  it("admission lock prevents concurrent writes from exceeding the cap", async () => {
    // 5 concurrent writes against a cap of 3 → exactly 3 succeed.
    const safetyDir = join(tmpHome, ".pi", "engineering-team");
    await mkdir(safetyDir, { recursive: true });
    await writeFile(
      join(safetyDir, "safety.json"),
      JSON.stringify({ approvalWatcher: { maxPendingPerRun: 3 } }),
      "utf8",
    );
    const tool = createRequestApprovalTool(runsDir, runId);
    const calls = Array.from({ length: 5 }).map((_, i) =>
      execTool(tool, { op: "bash", command: `echo ${i}`, justification: "race" }),
    );
    const results = await Promise.all(calls);
    const succeeded = results.filter((r) => r.requestId && !r.refused);
    const refused = results.filter((r) => r.refused === "per-run-pending-cap");
    expect(succeeded.length).toBe(3);
    expect(refused.length).toBe(2);
    // Disk state matches: exactly 3 .json files, no .tmp leftovers.
    const pendingDir = join(runsDir, runId, "approvals", "pending");
    const entries = await readdir(pendingDir);
    expect(entries.filter((n) => n.endsWith(".json")).length).toBe(3);
    expect(entries.filter((n) => n.endsWith(".tmp")).length).toBe(0);
  });

  it("releases admission lock after write so next call proceeds", async () => {
    const tool = createRequestApprovalTool(runsDir, runId);
    await execTool(tool, { op: "bash", command: "first", justification: "j1" });
    await execTool(tool, { op: "bash", command: "second", justification: "j2" });
    const lockExists = await stat(join(runsDir, runId, ".approval-admission.lock")).then(
      () => true,
      () => false,
    );
    expect(lockExists).toBe(false);
  });

  // Phase 5 review fixes — round 1 + 2 follow-up tests.

  it("rejects unsupported op (round-2 MEDIUM 1: ALLOWED_OPS allowlist)", async () => {
    const tool = createRequestApprovalTool(runsDir, runId);
    const r = await execTool(tool, {
      op: "arbitrary-malicious-op",
      command: "echo hi",
      justification: "should refuse",
    });
    expect(r.error).toMatch(/op must be one of/);
    expect(r.requestId).toBeUndefined();
  });

  it("admission lock owner.json is written with pid + hostname + instanceId, and a competing call sees it (round-2 HIGH 2)", async () => {
    // Plant a fresh, NOT-stale owner that belongs to a "different
    // process" so RequestApproval blocks on EEXIST + owner-present-
    // and-not-stale. The competing call should time out without
    // stealing the lock.
    const lockDir = join(runsDir, runId, ".approval-admission.lock");
    const ownerPath = join(lockDir, "owner.json");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    const myPid = process.pid;
    const liveOwner = {
      pid: myPid, // current process — alive, so isAdmissionOwnerStale returns false
      hostname: (await import("os")).hostname(),
      instanceId: "live-other-instance",
      acquiredAt: new Date().toISOString(),
    };
    await writeFile(ownerPath, JSON.stringify(liveOwner));
    const tool = createRequestApprovalTool(runsDir, runId);
    const r = await execTool(tool, { op: "bash", command: "blocked-by-live", justification: "j" });
    // Cannot acquire → admission-lock-timeout.
    expect(r.error).toMatch(/admission-lock-timeout/);
    // Owner file is unchanged — competing call did not steal.
    const afterRaw = await readFile(ownerPath, "utf8");
    const after = JSON.parse(afterRaw);
    expect(after.instanceId).toBe("live-other-instance");
  }, 10_000);

  it("stale admission lock (dead PID) is recovered on next acquire (round-2 HIGH 2)", async () => {
    // Plant a stale owner.json with a non-existent PID + same hostname,
    // then call RequestApproval — it should recover.
    const lockDir = join(runsDir, runId, ".approval-admission.lock");
    const ownerPath = join(lockDir, "owner.json");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await writeFile(
      ownerPath,
      JSON.stringify({
        pid: 9999999, // unreachable PID
        hostname: (await import("os")).hostname(),
        instanceId: "stale-ffff",
        acquiredAt: new Date().toISOString(),
      }),
    );
    const tool = createRequestApprovalTool(runsDir, runId);
    const r = await execTool(tool, {
      op: "bash",
      command: "after-stale",
      justification: "j",
    });
    // Stale-recovered → request succeeds.
    expect(r.requestId).toBeTruthy();
    expect(r.error).toBeUndefined();
  });

  it("admission lock with absent owner.json + young lock dir delays steal but eventually recovers (round-2 HIGH 2 — slow-disk safety)", async () => {
    // Plant a young lock dir without owner.json (simulates a slow-disk
    // winner mid-mkdir+write OR a true mid-acquire crash). The
    // contender must NOT instantly steal — it waits at least
    // ADMISSION_LOCK_DIR_MIN_AGE_MS (~500ms) before treating the dir
    // as crashed, then recovers and proceeds.
    const lockDir = join(runsDir, runId, ".approval-admission.lock");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    const tool = createRequestApprovalTool(runsDir, runId);
    const start = Date.now();
    const r = await execTool(tool, { op: "bash", command: "recovered", justification: "j" });
    const elapsed = Date.now() - start;
    // The request eventually succeeds (stale-mid-acquire recovered).
    expect(r.requestId).toBeTruthy();
    expect(r.error).toBeUndefined();
    // But not instantly — the mtime guard delayed us at least ~500ms.
    expect(elapsed).toBeGreaterThan(400);
  }, 10_000);

  it("findDuplicate ignores files with weird names (round-2 HIGH 1: path traversal defense)", async () => {
    const tool = createRequestApprovalTool(runsDir, runId);
    // Write a first request normally.
    const first = await execTool(tool, { op: "bash", command: "real", justification: "j" });
    const pendingDir = join(runsDir, runId, "approvals", "pending");
    // Drop a malicious entry with a null byte in the name — would be
    // ignored by readdir on most FS, but our containment check should
    // skip it defensively. We can't actually create a file with `\0`,
    // so simulate with a regular-but-weird name that is NOT a UUID:
    await writeFile(join(pendingDir, "..weird.json"), JSON.stringify({
      op: "bash",
      argsHash: "fake",
      issuedAtStepName: "build",
      issuedAtIteration: 2,
      requestId: "11111111-2222-3333-4444-555555555555",
    }));
    // A new request with the SAME op+command — fingerprint matches the
    // real first request, NOT the weird-named one.
    const second = await execTool(tool, { op: "bash", command: "real", justification: "j" });
    expect(second.requestId).toBe(first.requestId);
    expect(second.requestId).not.toBe("11111111-2222-3333-4444-555555555555");
  });
});
