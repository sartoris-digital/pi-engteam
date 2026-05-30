// tests/unit/commands/approve.test.ts
//
// Phase 2: unit tests for /approve + /deny commands.
// The controllerApproval module is mocked so tests are hermetic (no real fs).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks before any imports.
vi.mock("../../../src/safety/controllerApproval.js", () => ({
  readPendingControllerApproval: vi.fn(),
  mintControllerToken: vi.fn(),
  clearPendingControllerApproval: vi.fn(),
  recordPendingControllerApproval: vi.fn(),
  CONTROLLER_RUN_ID: "_controller",
  controllerDir: (runsDir: string) => `${runsDir}/_controller`,
  ensureControllerApprovalsDir: vi.fn(),
  getControllerSecret: vi.fn().mockReturnValue("a".repeat(64)),
  __resetControllerSecretForTest: vi.fn(),
}));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  readPendingControllerApproval,
  mintControllerToken,
  clearPendingControllerApproval,
} from "../../../src/safety/controllerApproval.js";
import { registerApproveCommands } from "../../../src/commands/approve.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const FAKE_RUNS_DIR = "/tmp/fake-runs";

/** Collect all registered handlers by command name. */
function buildMockPi(): {
  registerCommand: ReturnType<typeof vi.fn>;
  handlers: Map<string, (args: string, ctx: any) => Promise<void>>;
} {
  const handlers = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const registerCommand = vi.fn((name: string, opts: any) => {
    handlers.set(name, opts.handler);
  });
  return { registerCommand, handlers };
}

function buildMockCtx(opts?: { withCustomUi?: boolean; customResult?: { approved: boolean } }) {
  const notify = vi.fn();
  const ui: any = { notify };
  if (opts?.withCustomUi) {
    ui.custom = vi.fn().mockResolvedValue(opts.customResult ?? { approved: true });
  }
  return {
    ui,
    get lastMessage(): string { return (notify.mock.calls[0]?.[0] as string) ?? ""; },
    get lastLevel(): string { return (notify.mock.calls[0]?.[1] as string) ?? ""; },
  };
}

const FAKE_PENDING = {
  op: "bash",
  argsHash: "aabbcc",
  display: "rm -rf /tmp/old",
  ts: "2026-01-01T00:00:00.000Z",
};

const FAKE_EXPIRES_AT = "2026-01-01T00:05:00.000Z";

// ---------------------------------------------------------------------------
// /approve tests
// ---------------------------------------------------------------------------

describe("/approve command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("registers 'approve' and 'deny' commands", () => {
    const { registerCommand } = buildMockPi();
    registerApproveCommands({ registerCommand } as unknown as ExtensionAPI, FAKE_RUNS_DIR);
    const names = (registerCommand.mock.calls as [string, any][]).map(([n]) => n);
    expect(names).toContain("approve");
    expect(names).toContain("deny");
  });

  it("notifies 'Nothing pending approval.' when no pending record", async () => {
    vi.mocked(readPendingControllerApproval).mockResolvedValue(null);

    const { registerCommand, handlers } = buildMockPi();
    registerApproveCommands({ registerCommand } as unknown as ExtensionAPI, FAKE_RUNS_DIR);

    const ctx = buildMockCtx();
    await handlers.get("approve")!("", ctx);

    expect(ctx.lastMessage).toBe("Nothing pending approval.");
    expect(ctx.lastLevel).toBe("info");
    expect(mintControllerToken).not.toHaveBeenCalled();
  });

  it("mints a token and clears pending when no TUI (non-TUI path)", async () => {
    vi.mocked(readPendingControllerApproval).mockResolvedValue(FAKE_PENDING);
    vi.mocked(mintControllerToken).mockResolvedValue({
      tokenId: "tok-123",
      expiresAt: FAKE_EXPIRES_AT,
    });
    vi.mocked(clearPendingControllerApproval).mockResolvedValue(undefined);

    const { registerCommand, handlers } = buildMockPi();
    registerApproveCommands({ registerCommand } as unknown as ExtensionAPI, FAKE_RUNS_DIR);

    // No ctx.ui.custom → non-TUI path (human typed /approve = intent)
    const ctx = buildMockCtx({ withCustomUi: false });
    await handlers.get("approve")!("", ctx);

    expect(mintControllerToken).toHaveBeenCalledWith(FAKE_RUNS_DIR, {
      op: FAKE_PENDING.op,
      argsHash: FAKE_PENDING.argsHash,
    });
    expect(clearPendingControllerApproval).toHaveBeenCalledWith(FAKE_RUNS_DIR);

    // Final notify should mention the op and expiresAt
    const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const finalMsg = calls[calls.length - 1][0];
    expect(finalMsg).toContain(FAKE_PENDING.op);
    expect(finalMsg).toContain(FAKE_EXPIRES_AT);
  });

  it("mints a token when TUI overlay returns approved=true", async () => {
    vi.mocked(readPendingControllerApproval).mockResolvedValue(FAKE_PENDING);
    vi.mocked(mintControllerToken).mockResolvedValue({
      tokenId: "tok-456",
      expiresAt: FAKE_EXPIRES_AT,
    });
    vi.mocked(clearPendingControllerApproval).mockResolvedValue(undefined);

    const { registerCommand, handlers } = buildMockPi();
    registerApproveCommands({ registerCommand } as unknown as ExtensionAPI, FAKE_RUNS_DIR);

    const ctx = buildMockCtx({ withCustomUi: true, customResult: { approved: true } });
    await handlers.get("approve")!("", ctx);

    expect(mintControllerToken).toHaveBeenCalledWith(FAKE_RUNS_DIR, {
      op: FAKE_PENDING.op,
      argsHash: FAKE_PENDING.argsHash,
    });
    expect(clearPendingControllerApproval).toHaveBeenCalledWith(FAKE_RUNS_DIR);
  });

  it("does NOT mint a token when TUI overlay returns approved=false (operator cancelled)", async () => {
    vi.mocked(readPendingControllerApproval).mockResolvedValue(FAKE_PENDING);

    const { registerCommand, handlers } = buildMockPi();
    registerApproveCommands({ registerCommand } as unknown as ExtensionAPI, FAKE_RUNS_DIR);

    const ctx = buildMockCtx({ withCustomUi: true, customResult: { approved: false } });
    await handlers.get("approve")!("", ctx);

    expect(mintControllerToken).not.toHaveBeenCalled();
    expect(clearPendingControllerApproval).not.toHaveBeenCalled();

    const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const msg = calls[calls.length - 1][0];
    expect(msg).toMatch(/cancelled/i);
  });

  it("notifies an error if mintControllerToken throws", async () => {
    vi.mocked(readPendingControllerApproval).mockResolvedValue(FAKE_PENDING);
    vi.mocked(mintControllerToken).mockRejectedValue(new Error("disk full"));

    const { registerCommand, handlers } = buildMockPi();
    registerApproveCommands({ registerCommand } as unknown as ExtensionAPI, FAKE_RUNS_DIR);

    const ctx = buildMockCtx({ withCustomUi: false });
    await handlers.get("approve")!("", ctx);

    const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const errMsg = calls[calls.length - 1][0];
    expect(errMsg).toContain("disk full");
    expect(calls[calls.length - 1][1]).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// /deny tests
// ---------------------------------------------------------------------------

describe("/deny command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("clears pending and notifies 'Pending approval cleared.'", async () => {
    vi.mocked(clearPendingControllerApproval).mockResolvedValue(undefined);

    const { registerCommand, handlers } = buildMockPi();
    registerApproveCommands({ registerCommand } as unknown as ExtensionAPI, FAKE_RUNS_DIR);

    const ctx = buildMockCtx();
    await handlers.get("deny")!("", ctx);

    expect(clearPendingControllerApproval).toHaveBeenCalledWith(FAKE_RUNS_DIR);
    expect(ctx.lastMessage).toBe("Pending approval cleared.");
    expect(ctx.lastLevel).toBe("info");
  });

  it("notifies an error if clearPendingControllerApproval throws", async () => {
    vi.mocked(clearPendingControllerApproval).mockRejectedValue(new Error("EPERM"));

    const { registerCommand, handlers } = buildMockPi();
    registerApproveCommands({ registerCommand } as unknown as ExtensionAPI, FAKE_RUNS_DIR);

    const ctx = buildMockCtx();
    await handlers.get("deny")!("", ctx);

    expect(ctx.lastMessage).toContain("EPERM");
    expect(ctx.lastLevel).toBe("error");
  });
});
