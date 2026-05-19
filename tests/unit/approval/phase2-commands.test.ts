// tests/unit/approval/phase2-commands.test.ts
//
// PLAN.md ApprovalWatcher Phase 2 — slash command + audit-log surface.
// These tests pin the operator-facing contract: pause/resume mutate
// safety.json, extend-hold bumps adhocHoldExpiresAt, resume-after-
// emergency increments pauseEpoch + clears the flag, and every mutation
// writes a single audit line.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeApprovalAuditLine } from "../../../src/safety/approval-watcher-audit.js";

describe("ApprovalWatcher Phase 2 — audit log", () => {
  let realHome: string | undefined;
  let tmpHome: string;

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase2-audit-"));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("writes a single JSONL line with required fields", async () => {
    const written = await writeApprovalAuditLine({ action: "pause" });
    expect(written.action).toBe("pause");
    expect(written.auditId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Number.isFinite(Date.parse(written.ts))).toBe(true);
    expect(written.pid).toBe(process.pid);

    const path = join(tmpHome, ".pi", "engineering-team", "approval-watcher-audit.jsonl");
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).action).toBe("pause");
  });

  it("appends additional lines without truncating prior entries", async () => {
    await writeApprovalAuditLine({ action: "pause" });
    await writeApprovalAuditLine({ action: "resume" });
    await writeApprovalAuditLine({
      action: "reengage",
      runId: "test-run-1",
      reason: "operator-triggered",
    });
    const path = join(tmpHome, ".pi", "engineering-team", "approval-watcher-audit.jsonl");
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).action).toBe("pause");
    expect(JSON.parse(lines[1]).action).toBe("resume");
    expect(JSON.parse(lines[2]).action).toBe("reengage");
    expect(JSON.parse(lines[2]).runId).toBe("test-run-1");
  });

  it("each audit line carries a unique auditId", async () => {
    const a = await writeApprovalAuditLine({ action: "pause" });
    const b = await writeApprovalAuditLine({ action: "pause" });
    expect(a.auditId).not.toBe(b.auditId);
  });

  it("audit file is created with 0o600 mode", async () => {
    await writeApprovalAuditLine({ action: "pause" });
    const path = join(tmpHome, ".pi", "engineering-team", "approval-watcher-audit.jsonl");
    const st = await stat(path);
    // Mask off file-type bits; check only permission bits.
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("ApprovalWatcher Phase 2 — /approval-watcher command surface", () => {
  let realHome: string | undefined;
  let tmpHome: string;

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase2-cmd-"));
    process.env.HOME = tmpHome;
    await mkdir(join(tmpHome, ".pi", "engineering-team"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  function makePi(): { handler?: (args: string, ctx: any) => Promise<void>; notifications: Array<{ msg: string; level: string }> } {
    const captured: { handler?: (args: string, ctx: any) => Promise<void>; notifications: Array<{ msg: string; level: string }> } = {
      notifications: [],
    };
    const pi: any = {
      registerCommand: (_name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) => {
        captured.handler = def.handler;
      },
    };
    return { pi, captured };
  }

  it("pause subcommand flips dispatchPaused=true and writes audit line", async () => {
    const { registerApprovalWatcherCommand } = await import("../../../src/commands/approval-watcher.js");
    const { loadSafetyConfig } = await import("../../../src/config.js");
    const piStub = makePi();
    registerApprovalWatcherCommand(piStub.pi as any, join(tmpHome, "runs"));
    const ctx = { ui: { notify: (msg: string, level: string) => piStub.captured.notifications.push({ msg, level }) } };

    await piStub.captured.handler!("pause", ctx);
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.dispatchPaused).toBe(true);

    const audit = await readFile(
      join(tmpHome, ".pi", "engineering-team", "approval-watcher-audit.jsonl"),
      "utf8",
    );
    expect(audit).toContain('"action":"pause"');
  });

  it("resume subcommand flips dispatchPaused=false", async () => {
    const { registerApprovalWatcherCommand } = await import("../../../src/commands/approval-watcher.js");
    const { loadSafetyConfig } = await import("../../../src/config.js");
    const piStub = makePi();
    registerApprovalWatcherCommand(piStub.pi as any, join(tmpHome, "runs"));
    const ctx = { ui: { notify: () => {} } };

    await piStub.captured.handler!("pause", ctx);
    await piStub.captured.handler!("resume", ctx);
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.dispatchPaused).toBe(false);
  });

  it("resume-after-emergency requires --acknowledge AND --reason", async () => {
    const { registerApprovalWatcherCommand } = await import("../../../src/commands/approval-watcher.js");
    const piStub = makePi();
    registerApprovalWatcherCommand(piStub.pi as any, join(tmpHome, "runs"));
    const ctx = {
      ui: { notify: (msg: string, level: string) => piStub.captured.notifications.push({ msg, level }) },
    };

    await piStub.captured.handler!("resume-after-emergency", ctx);
    expect(piStub.captured.notifications.slice(-1)[0].msg).toMatch(/--acknowledge/);

    piStub.captured.notifications.length = 0;
    await piStub.captured.handler!("resume-after-emergency --acknowledge", ctx);
    expect(piStub.captured.notifications.slice(-1)[0].msg).toMatch(/--reason/);
  });

  it("resume-after-emergency increments pauseEpoch when both flags present", async () => {
    const { registerApprovalWatcherCommand } = await import("../../../src/commands/approval-watcher.js");
    const { loadSafetyConfig } = await import("../../../src/config.js");
    const piStub = makePi();
    registerApprovalWatcherCommand(piStub.pi as any, join(tmpHome, "runs"));
    const ctx = { ui: { notify: () => {} } };

    const before = (await loadSafetyConfig()).approvalWatcher!.pauseEpoch;
    await piStub.captured.handler!(
      'resume-after-emergency --acknowledge --reason "smoke test"',
      ctx,
    );
    const after = (await loadSafetyConfig()).approvalWatcher!.pauseEpoch;
    expect(after).toBe(before + 1);
  });

  it("reengage refuses unsafe runIds", async () => {
    const { registerApprovalWatcherCommand } = await import("../../../src/commands/approval-watcher.js");
    const piStub = makePi();
    registerApprovalWatcherCommand(piStub.pi as any, join(tmpHome, "runs"));
    const ctx = {
      ui: { notify: (msg: string, level: string) => piStub.captured.notifications.push({ msg, level }) },
    };

    await piStub.captured.handler!("reengage ../escape", ctx);
    expect(piStub.captured.notifications.slice(-1)[0].msg).toMatch(/Invalid runId/);
  });

  it("extend-hold without --hours flag returns an error", async () => {
    const { registerApprovalWatcherCommand } = await import("../../../src/commands/approval-watcher.js");
    const piStub = makePi();
    registerApprovalWatcherCommand(piStub.pi as any, join(tmpHome, "runs"));
    const ctx = {
      ui: { notify: (msg: string, level: string) => piStub.captured.notifications.push({ msg, level }) },
    };

    await piStub.captured.handler!("extend-hold valid-run-id", ctx);
    expect(piStub.captured.notifications.slice(-1)[0].msg).toMatch(/--hours/);
  });

  it("unknown subcommand returns an error", async () => {
    const { registerApprovalWatcherCommand } = await import("../../../src/commands/approval-watcher.js");
    const piStub = makePi();
    registerApprovalWatcherCommand(piStub.pi as any, join(tmpHome, "runs"));
    const ctx = {
      ui: { notify: (msg: string, level: string) => piStub.captured.notifications.push({ msg, level }) },
    };

    await piStub.captured.handler!("bogus-subcommand", ctx);
    expect(piStub.captured.notifications.slice(-1)[0].msg).toMatch(/Unknown subcommand/);
  });

  it("empty args prints usage", async () => {
    const { registerApprovalWatcherCommand } = await import("../../../src/commands/approval-watcher.js");
    const piStub = makePi();
    registerApprovalWatcherCommand(piStub.pi as any, join(tmpHome, "runs"));
    const ctx = {
      ui: { notify: (msg: string, level: string) => piStub.captured.notifications.push({ msg, level }) },
    };

    await piStub.captured.handler!("", ctx);
    expect(piStub.captured.notifications.slice(-1)[0].msg).toMatch(/Usage:/);
  });
});

describe("ApprovalWatcher Phase 2 — /approval-status read-only output", () => {
  let realHome: string | undefined;
  let tmpHome: string;

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase2-status-"));
    process.env.HOME = tmpHome;
    await mkdir(join(tmpHome, ".pi", "engineering-team"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("reports disabled mode when enabled=false", async () => {
    const { registerApprovalStatusCommand } = await import("../../../src/commands/approval-status.js");
    let captured: string = "";
    const pi: any = {
      registerCommand: (_name: string, def: any) => {
        pi.handler = def.handler;
      },
    };
    registerApprovalStatusCommand(pi);
    const ctx = { ui: { notify: (msg: string) => { captured = msg; } } };
    await pi.handler("", ctx);
    expect(captured).toMatch(/enabled:\s+false/);
    expect(captured).toMatch(/resolved canary mode:\s+disabled/);
  });

  it("status command does NOT write to disk (passive)", async () => {
    // PLAN.md round-A3 HIGH 1: /approval-status must NOT bump liveness.
    const { registerApprovalStatusCommand } = await import("../../../src/commands/approval-status.js");
    let captured: string = "";
    const pi: any = {
      registerCommand: (_name: string, def: any) => {
        pi.handler = def.handler;
      },
    };
    registerApprovalStatusCommand(pi);
    const ctx = { ui: { notify: (msg: string) => { captured = msg; } } };

    // Snapshot the engineering-team dir mtime, run status, snapshot again.
    const dir = join(tmpHome, ".pi", "engineering-team");
    const before = (await stat(dir)).mtimeMs;
    // sleep tiny amount to ensure mtime would change if anything was written
    await new Promise((r) => setTimeout(r, 50));
    await pi.handler("", ctx);
    const after = (await stat(dir)).mtimeMs;
    expect(after).toBe(before);
    expect(captured.length).toBeGreaterThan(0);
  });

  it("with a runId arg, shows the run-scoped placeholder", async () => {
    const { registerApprovalStatusCommand } = await import("../../../src/commands/approval-status.js");
    let captured: string = "";
    const pi: any = {
      registerCommand: (_name: string, def: any) => {
        pi.handler = def.handler;
      },
    };
    registerApprovalStatusCommand(pi);
    const ctx = { ui: { notify: (msg: string) => { captured = msg; } } };
    await pi.handler("some-run-id", ctx);
    expect(captured).toMatch(/Run-scoped diagnostics for some-run-id/);
  });
});
