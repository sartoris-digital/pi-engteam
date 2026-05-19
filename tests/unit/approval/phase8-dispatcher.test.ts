// tests/unit/approval/phase8-dispatcher.test.ts
//
// PLAN.md ApprovalWatcher Phase 8 — ApprovalDispatcher drain core.
//
// The dispatcher claims pending/<id>.json files via atomic rename to
// .dispatching, validates the schema, invokes a dispatch callback,
// and routes the result to .granted / quarantine / requeue.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  registerApprovalDispatcher,
  __test as dispatcherTest,
} from "../../../src/safety/approval-dispatcher.js";
import type { PendingRequestV1, DispatchOutcome } from "../../../src/safety/approval-dispatcher.js";

function makeRequest(runId: string, overrides: Partial<PendingRequestV1> = {}): PendingRequestV1 {
  return {
    schemaVersion: 1,
    requestId: randomUUID(),
    runId,
    op: "bash",
    command: "echo test",
    justification: "test",
    argsHash: "deadbeef",
    issuedAtStepName: "build",
    issuedAtIteration: 1,
    issuedAtNonce: "abcdef0123456789",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function plantPending(pendingDir: string, request: PendingRequestV1): Promise<string> {
  await mkdir(pendingDir, { recursive: true, mode: 0o700 });
  const path = join(pendingDir, `${request.requestId}.json`);
  await writeFile(path, JSON.stringify(request, null, 2), { mode: 0o600 });
  return path;
}

describe("ApprovalWatcher Phase 8 — dispatcher drain + claim semantics", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let runsDir: string;
  const runId = "phase8-test";

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase8-"));
    process.env.HOME = tmpHome;
    runsDir = join(tmpHome, "runs");
    await mkdir(join(runsDir, runId), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("granted outcome: pending file is renamed to <id>.json.granted", async () => {
    const dispatched: PendingRequestV1[] = [];
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async (req) => {
        dispatched.push(req);
        return { kind: "granted" };
      },
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");

    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const req = makeRequest(runId);
      await plantPending(pendingDir, req);
      const result = await handle.drainOnce();
      expect(result.dispatched).toBe(1);
      expect(result.quarantined).toBe(0);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].requestId).toBe(req.requestId);
      const grantedPath = join(pendingDir, `${req.requestId}.json.granted`);
      await expect(stat(grantedPath)).resolves.toBeTruthy();
    } finally {
      await handle.stop();
    }
  });

  it("denied outcome: file moves to quarantine with denied:<reason>", async () => {
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => ({ kind: "denied", reason: "judge-said-no" }),
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const quarantineDir = join(runsDir, runId, "approvals", "quarantine");
      const req = makeRequest(runId);
      await plantPending(pendingDir, req);
      const result = await handle.drainOnce();
      expect(result.quarantined).toBe(1);
      const reasonFile = join(quarantineDir, `${req.requestId}.reason.json`);
      const reason = JSON.parse(await readFile(reasonFile, "utf8"));
      expect(reason.reason).toBe("denied:judge-said-no");
    } finally {
      await handle.stop();
    }
  });

  it("requeue outcome: file goes back to pending and retry counter bumps", async () => {
    let attempts = 0;
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => {
        attempts++;
        return { kind: "requeue", reason: "transient-error" };
      },
      pollIntervalMs: 99_999,
      maxRetryAttempts: 3,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const metaDir = join(runsDir, runId, "approvals", "meta");
      const req = makeRequest(runId);
      await plantPending(pendingDir, req);

      // 1st drain → requeue (attempts=1)
      const r1 = await handle.drainOnce();
      expect(r1.requeued).toBe(1);
      const counter1 = JSON.parse(await readFile(join(metaDir, `${req.requestId}.retry.json`), "utf8"));
      expect(counter1.attempts).toBe(1);
      await expect(stat(join(pendingDir, `${req.requestId}.json`))).resolves.toBeTruthy();

      // 2nd drain → requeue (attempts=2)
      const r2 = await handle.drainOnce();
      expect(r2.requeued).toBe(1);

      // 3rd drain → attempts=3 → quarantine "max-retries"
      const r3 = await handle.drainOnce();
      expect(r3.quarantined).toBe(1);
      const reason = JSON.parse(
        await readFile(join(runsDir, runId, "approvals", "quarantine", `${req.requestId}.reason.json`), "utf8"),
      );
      expect(reason.reason).toBe("max-retries");
      expect(attempts).toBe(3);
    } finally {
      await handle.stop();
    }
  });

  it("malformed JSON: quarantined with parse-failure reason", async () => {
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => ({ kind: "granted" }),
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const garbageId = randomUUID();
      await writeFile(join(pendingDir, `${garbageId}.json`), "not-valid-json-{");
      const result = await handle.drainOnce();
      expect(result.quarantined).toBe(1);
      const reasonFile = join(runsDir, runId, "approvals", "quarantine", `${garbageId}.reason.json`);
      const reason = JSON.parse(await readFile(reasonFile, "utf8"));
      expect(reason.reason).toBe("parse-failure");
    } finally {
      await handle.stop();
    }
  });

  it("runId-mismatch: quarantined with reason", async () => {
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => ({ kind: "granted" }),
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const req = makeRequest("OTHER-RUN"); // wrong runId on payload
      await plantPending(pendingDir, req);
      const result = await handle.drainOnce();
      expect(result.quarantined).toBe(1);
      const reasonFile = join(runsDir, runId, "approvals", "quarantine", `${req.requestId}.reason.json`);
      const reason = JSON.parse(await readFile(reasonFile, "utf8"));
      expect(reason.reason).toBe("runId-mismatch-with-directory");
    } finally {
      await handle.stop();
    }
  });

  it("invalid op: quarantined with unknown-op reason", async () => {
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => ({ kind: "granted" }),
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const req = makeRequest(runId, { op: "malicious-rm-rf" });
      await plantPending(pendingDir, req);
      const result = await handle.drainOnce();
      expect(result.quarantined).toBe(1);
      const reasonFile = join(runsDir, runId, "approvals", "quarantine", `${req.requestId}.reason.json`);
      const reason = JSON.parse(await readFile(reasonFile, "utf8"));
      expect(reason.reason).toMatch(/unknown-op-malicious-rm-rf/);
    } finally {
      await handle.stop();
    }
  });

  it("strict UUID filter: non-uuid filenames are skipped", async () => {
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => ({ kind: "granted" }),
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      await writeFile(join(pendingDir, "not-a-uuid.json"), JSON.stringify({}));
      await writeFile(join(pendingDir, "config.json"), JSON.stringify({}));
      const result = await handle.drainOnce();
      // Non-UUID names are silently skipped — not dispatched, not quarantined.
      expect(result.dispatched).toBe(0);
      expect(result.quarantined).toBe(0);
      // The files remain in pending — dispatcher just ignores them.
      const remaining = (await readdir(pendingDir)).filter((n) => n.endsWith(".json"));
      expect(remaining).toContain("not-a-uuid.json");
      expect(remaining).toContain("config.json");
    } finally {
      await handle.stop();
    }
  });

  it("dispatch callback throwing → requeue, then eventually quarantine on max-retries", async () => {
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => {
        throw new Error("boom");
      },
      pollIntervalMs: 99_999,
      maxRetryAttempts: 2,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const req = makeRequest(runId);
      await plantPending(pendingDir, req);
      const r1 = await handle.drainOnce();
      expect(r1.requeued).toBe(1);
      const r2 = await handle.drainOnce();
      expect(r2.quarantined).toBe(1);
      const reasonPath = join(runsDir, runId, "approvals", "quarantine", `${req.requestId}.reason.json`);
      const reason = JSON.parse(await readFile(reasonPath, "utf8"));
      expect(reason.reason).toBe("max-retries");
      expect(reason.context?.lastReason).toBe("boom");
    } finally {
      await handle.stop();
    }
  });

  it("register fails when approvals layout is unsafe", async () => {
    // Plant a symlinked approvals/ — ensureApprovalsLayout refuses.
    const decoy = join(tmpHome, "decoy");
    await mkdir(decoy, { recursive: true });
    const { symlink } = await import("fs/promises");
    await symlink(decoy, join(runsDir, runId, "approvals"));
    const result = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => ({ kind: "granted" }),
    });
    expect("ok" in result && result.ok === false).toBe(true);
    if ("reason" in result) expect(result.reason).toMatch(/layout-symlink-detected/);
  });

  it("atomic claim: concurrent drain doesn't double-dispatch the same file", async () => {
    let dispatchCount = 0;
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => {
        dispatchCount++;
        // simulate slow Judge
        await new Promise((r) => setTimeout(r, 30));
        return { kind: "granted" };
      },
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const req = makeRequest(runId);
      await plantPending(pendingDir, req);
      // Two concurrent drains — atomic rename ensures only one wins.
      const [r1, r2] = await Promise.all([handle.drainOnce(), handle.drainOnce()]);
      expect(r1.dispatched + r2.dispatched).toBe(1);
      expect(dispatchCount).toBe(1);
    } finally {
      await handle.stop();
    }
  });
});

describe("ApprovalWatcher Phase 8 review fixes — drain serialization + lease-ownership gate", () => {
  let tmpHome: string;
  let realHome: string | undefined;
  let runsDir: string;
  const runId = "phase8-fix-test";

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase8-fix-"));
    process.env.HOME = tmpHome;
    runsDir = join(tmpHome, "runs");
    await mkdir(join(runsDir, runId), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("drain serialization: overlapping drainOnce calls execute one-at-a-time (round-1 HIGH 1)", async () => {
    const dispatched: PendingRequestV1[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async (req) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        dispatched.push(req);
        inFlight--;
        return { kind: "granted" };
      },
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      for (let i = 0; i < 5; i++) await plantPending(pendingDir, makeRequest(runId));
      // Fire 5 overlapping drainOnce calls.
      const results = await Promise.all(Array.from({ length: 5 }).map(() => handle.drainOnce()));
      expect(dispatched.length).toBe(5);
      // Serialization invariant: never more than one dispatch in flight.
      expect(maxInFlight).toBeLessThanOrEqual(1);
      // Aggregate dispatched count across the 5 results equals 5.
      const totalDispatched = results.reduce((sum, r) => sum + r.dispatched, 0);
      expect(totalDispatched).toBe(5);
    } finally {
      await handle.stop();
    }
  });

  it("lease-loss self-disable: dispatcher refuses to mutate after a successor steals the lease (round-1 HIGH 2)", async () => {
    let callbackInvocations = 0;
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async () => {
        callbackInvocations++;
        return { kind: "granted" };
      },
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");
    try {
      // Plant a pending file.
      const pendingDir = join(runsDir, runId, "approvals", "pending");
      const req = makeRequest(runId);
      await plantPending(pendingDir, req);

      // Simulate a successor stealing the lease by overwriting owner.json
      // with a different instanceId.
      const lockDir = join(runsDir, runId, ".approval-watcher.lease.lock");
      const ownerPath = join(lockDir, "owner.json");
      const successor = {
        pid: process.pid,
        hostname: handle.lease.owner.hostname,
        instanceId: "successor-stole-it",
        acquiredAt: new Date().toISOString(),
        renewedAt: new Date().toISOString(),
      };
      await writeFile(ownerPath, JSON.stringify(successor));

      // Now drain — must refuse because we no longer own the lease.
      const result = await handle.drainOnce();
      expect(result.dispatched).toBe(0);
      expect(result.quarantined).toBe(0);
      expect(callbackInvocations).toBe(0);
      // Pending file is untouched (successor's responsibility now).
      const { stat: statFs } = await import("fs/promises");
      await expect(statFs(join(pendingDir, `${req.requestId}.json`))).resolves.toBeTruthy();
    } finally {
      await handle.stop();
    }
  });

  it("stop() awaits in-flight drain before releasing the lease", async () => {
    const dispatchOrder: string[] = [];
    const handle = await registerApprovalDispatcher({
      runsDir,
      runId,
      dispatch: async (req) => {
        dispatchOrder.push("started");
        await new Promise((r) => setTimeout(r, 40));
        dispatchOrder.push("finished");
        return { kind: "granted" };
      },
      pollIntervalMs: 99_999,
    });
    if ("ok" in handle && !handle.ok) throw new Error(`register failed: ${handle.reason}`);
    if (!("drainOnce" in handle)) throw new Error("not a handle");

    const pendingDir = join(runsDir, runId, "approvals", "pending");
    await plantPending(pendingDir, makeRequest(runId));
    const drainP = handle.drainOnce(); // fire and forget
    await new Promise((r) => setTimeout(r, 5)); // let it start
    await handle.stop();
    await drainP;
    expect(dispatchOrder).toEqual(["started", "finished"]);
  });
});

describe("ApprovalWatcher Phase 8 — validateRequest", () => {
  const runId = "valid-run";
  it("accepts a well-formed v1 request", () => {
    const req = makeRequest(runId);
    const result = dispatcherTest.validateRequest(req, runId, req.requestId);
    expect("reason" in result).toBe(false);
  });

  it("rejects schemaVersion != 1", () => {
    const req = makeRequest(runId) as unknown as Record<string, unknown>;
    req.schemaVersion = 2;
    const result = dispatcherTest.validateRequest(req, runId, req.requestId as string);
    expect("reason" in result && (result as { reason: string }).reason).toMatch(/unsupported-schema-version/);
  });

  it("rejects requestId not matching filename", () => {
    const req = makeRequest(runId);
    const result = dispatcherTest.validateRequest(req, runId, "different-uuid");
    expect("reason" in result && (result as { reason: string }).reason).toBe("requestId-mismatch-with-filename");
  });

  it("rejects missing required field", () => {
    const req = makeRequest(runId) as Record<string, unknown>;
    delete req.argsHash;
    const result = dispatcherTest.validateRequest(req, runId, req.requestId as string);
    expect("reason" in result && (result as { reason: string }).reason).toBe("missing-argsHash");
  });
});
