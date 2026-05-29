import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks before any imports.

vi.mock("../../../src/secrets/Passphrase.js", () => ({
  isTtyAvailable: vi.fn(),
  promptPassphrase: vi.fn(),
}));

vi.mock("../../../src/commands/secret-shared.js", () => ({
  buildMasterKeyManager: vi.fn(),
  VAULT_DB_PATH: "/tmp/fake-secrets.db",
}));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isTtyAvailable, promptPassphrase } from "../../../src/secrets/Passphrase.js";
import { buildMasterKeyManager } from "../../../src/commands/secret-shared.js";
import { registerSecretSetupRecoveryCommand } from "../../../src/commands/secret-setup-recovery.js";

// ---------------------------------------------------------------------------
// Test harness (mirrors doctor.test.ts)
// ---------------------------------------------------------------------------

function buildMockPi(): { registerCommand: ReturnType<typeof vi.fn>; lastHandler: any } {
  let lastHandler: any;
  const registerCommand = vi.fn((_name: string, opts: any) => {
    lastHandler = opts.handler;
  });
  return {
    registerCommand,
    get lastHandler() { return lastHandler; },
  };
}

function buildMockCtx() {
  const notify = vi.fn();
  return {
    ui: { notify },
    get lastMessage(): string {
      const calls = notify.mock.calls;
      return (calls[calls.length - 1]?.[0] as string) ?? "";
    },
  };
}

// A minimal fake manager with the three methods the command uses.
function fakeManager(opts: {
  throwOnInit?: boolean;
  enrollRecovery?: () => Promise<void>;
}) {
  return {
    ensureInitialized: vi.fn(async () => {
      if (opts.throwOnInit) throw new Error("Vault unavailable: test error");
      return Buffer.alloc(32);
    }),
    enrollRecovery: vi.fn(opts.enrollRecovery ?? (async () => {})),
    zeroize: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerSecretSetupRecoveryCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function getHandler() {
    const mock = buildMockPi();
    registerSecretSetupRecoveryCommand(mock as unknown as ExtensionAPI);
    return mock.lastHandler;
  }

  // 1 ─ headless: isTtyAvailable → false
  it("headless (isTtyAvailable=false) → error about interactive terminal, manager not built", async () => {
    vi.mocked(isTtyAvailable).mockReturnValue(false);

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/interactive terminal/i);
    expect(vi.mocked(buildMasterKeyManager)).not.toHaveBeenCalled();
  });

  // 2 ─ happy path: passphrase provided, enrollRecovery called, success message
  it("happy path → enrollRecovery called with passphrase; enrolled success message; zeroize called", async () => {
    vi.mocked(isTtyAvailable).mockReturnValue(true);
    vi.mocked(promptPassphrase).mockResolvedValue("strong-pass" as any);

    const manager = fakeManager({});
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(manager.enrollRecovery).toHaveBeenCalledOnce();
    expect(manager.enrollRecovery.mock.calls[0][0]).toBe("strong-pass");
    expect(ctx.lastMessage).toMatch(/enrolled/i);
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 3 ─ empty passphrase → "must not be empty", enrollRecovery NOT called, zeroize called
  it("empty passphrase → 'must not be empty' error, enrollRecovery not called, zeroize called", async () => {
    vi.mocked(isTtyAvailable).mockReturnValue(true);
    vi.mocked(promptPassphrase).mockResolvedValue("" as any);

    const manager = fakeManager({});
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/must not be empty/i);
    expect(manager.enrollRecovery).not.toHaveBeenCalled();
    expect(manager.zeroize).toHaveBeenCalled();
  });
});
