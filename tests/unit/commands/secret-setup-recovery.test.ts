import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks before any imports.

vi.mock("../../../src/commands/secret-shared.js", () => ({
  buildMasterKeyManager: vi.fn(),
  VAULT_DB_PATH: "/tmp/fake-secrets.db",
  // Real implementation: hasMaskedPrompt checks for ctx.ui.custom being a function.
  hasMaskedPrompt: (ctx: any) => typeof ctx?.ui?.custom === "function",
  promptMaskedPassphrase: vi.fn(),
}));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildMasterKeyManager, promptMaskedPassphrase } from "../../../src/commands/secret-shared.js";
import { registerSecretSetupRecoveryCommand } from "../../../src/commands/secret-setup-recovery.js";

// ---------------------------------------------------------------------------
// Test harness
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

function buildMockCtx(opts?: { noCustom?: boolean }) {
  const notify = vi.fn();
  const ui: any = { notify };
  if (!opts?.noCustom) {
    // Provide a real ctx.ui.custom so hasMaskedPrompt returns true.
    // The actual prompt results are controlled via promptMaskedPassphrase mock.
    ui.custom = vi.fn();
  }
  return {
    ui,
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

  // 1 ─ no masked prompt (ctx.ui.custom absent) → error, manager not built
  it("no masked prompt (ctx.ui.custom absent) → error about interactive Pi session, manager not built", async () => {
    const handler = getHandler();
    const ctx = buildMockCtx({ noCustom: true });
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/interactive pi session/i);
    expect(vi.mocked(buildMasterKeyManager)).not.toHaveBeenCalled();
  });

  // 2 ─ happy path: both prompts match → enrollRecovery called, success message, zeroize
  it("happy path → enrollRecovery called with passphrase; enrolled success message; zeroize called", async () => {
    const manager = fakeManager({});
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);
    vi.mocked(promptMaskedPassphrase)
      .mockResolvedValueOnce({ value: "strong-pass", cancelled: false })
      .mockResolvedValueOnce({ value: "strong-pass", cancelled: false });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(manager.enrollRecovery).toHaveBeenCalledOnce();
    expect(manager.enrollRecovery.mock.calls[0][0]).toBe("strong-pass");
    expect(ctx.lastMessage).toMatch(/enrolled/i);
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 3 ─ mismatch: first and confirm differ → "Passphrases do not match.", enrollRecovery NOT called, zeroize
  it("passphrase mismatch → 'Passphrases do not match.' error, enrollRecovery not called, zeroize called", async () => {
    const manager = fakeManager({});
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);
    vi.mocked(promptMaskedPassphrase)
      .mockResolvedValueOnce({ value: "a", cancelled: false })
      .mockResolvedValueOnce({ value: "b", cancelled: false });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/passphrases do not match/i);
    expect(manager.enrollRecovery).not.toHaveBeenCalled();
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 4 ─ empty passphrase → "must not be empty", enrollRecovery NOT called, zeroize
  it("empty passphrase → 'must not be empty' error, enrollRecovery not called, zeroize called", async () => {
    const manager = fakeManager({});
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);
    vi.mocked(promptMaskedPassphrase)
      .mockResolvedValueOnce({ value: "", cancelled: false });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/must not be empty/i);
    expect(manager.enrollRecovery).not.toHaveBeenCalled();
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 5 ─ user cancels the first prompt → "cancelled", enrollRecovery NOT called, zeroize
  it("user cancels first prompt → 'cancelled' message, enrollRecovery not called, zeroize called", async () => {
    const manager = fakeManager({});
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);
    vi.mocked(promptMaskedPassphrase)
      .mockResolvedValueOnce({ value: "", cancelled: true });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/cancelled/i);
    expect(manager.enrollRecovery).not.toHaveBeenCalled();
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 6 ─ vault unavailable (ensureInitialized throws) → error, no prompts, zeroize
  it("vault unavailable → error message, no prompts attempted", async () => {
    const manager = fakeManager({ throwOnInit: true });
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/vault unavailable/i);
    expect(vi.mocked(promptMaskedPassphrase)).not.toHaveBeenCalled();
    expect(manager.enrollRecovery).not.toHaveBeenCalled();
    expect(manager.zeroize).toHaveBeenCalled();
  });
});
