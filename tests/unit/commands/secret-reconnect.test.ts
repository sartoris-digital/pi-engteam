import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks before any imports so they are in place when modules resolve.

vi.mock("fs", async (importActual) => {
  const actual = await importActual<typeof import("fs")>();
  return {
    ...actual,
    // Mode2 vault-file check: pretend the DB exists so the handler doesn't bail early.
    existsSync: (p: any) => (String(p).includes("secrets.db") ? true : actual.existsSync(p)),
  };
});

vi.mock("../../../src/secrets/Keyring.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/secrets/Keyring.js")>();
  return {
    ...actual,
    // Keep the real decideReconnectMode, KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER.
    // Override only the two I/O functions so tests are hermetic.
    diagnoseKeyring: vi.fn(),
    createKeyringBackend: vi.fn(),
  };
});

vi.mock("../../../src/commands/secret-shared.js", () => ({
  buildMasterKeyManager: vi.fn(),
  VAULT_DB_PATH: "/tmp/fake-secrets.db",
  hasMaskedPrompt: (ctx: any) => typeof ctx?.ui?.custom === "function",
  promptMaskedPassphrase: vi.fn(),
}));

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { diagnoseKeyring, createKeyringBackend, KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER } from "../../../src/secrets/Keyring.js";
import { buildMasterKeyManager, promptMaskedPassphrase } from "../../../src/commands/secret-shared.js";
import { registerSecretReconnectCommand } from "../../../src/commands/secret-reconnect.js";

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
    // Present only so hasMaskedPrompt(ctx) returns true. The handler never invokes
    // ctx.ui.custom directly — promptMaskedPassphrase is module-mocked, so the
    // entered passphrase is controlled via vi.mocked(promptMaskedPassphrase).
    ui.custom = vi.fn();
  }
  return {
    ui,
    // Returns the LAST notify message (the handler can call notify multiple times;
    // typically the final one is the meaningful outcome).
    get lastMessage(): string {
      const calls = notify.mock.calls;
      return (calls[calls.length - 1]?.[0] as string) ?? "";
    },
    // Returns the first notify message.
    get firstMessage(): string {
      return (notify.mock.calls[0]?.[0] as string) ?? "";
    },
  };
}

// A fake keyring backend whose get() returns either a "value" or "not-found".
function fakeBackend(getKind: "value" | "not-found") {
  return {
    get: vi.fn(() => ({ kind: getKind as "value" | "not-found" })),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

// A fake MasterKeyManager returned by the mocked buildMasterKeyManager.
function fakeManager(opts: { key?: Buffer; throwOnRecover?: boolean }) {
  return {
    recoverWithPassphrase: vi.fn(async () => {
      if (opts.throwOnRecover) throw new Error("Passphrase did not match.");
      return opts.key ?? Buffer.alloc(32, 7);
    }),
    zeroize: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerSecretReconnectCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Helper: register a fresh command and return the handler.
  function getHandler() {
    const mock = buildMockPi();
    registerSecretReconnectCommand(mock as unknown as ExtensionAPI);
    return mock.lastHandler;
  }

  // 1 ─ mode1 (load-failed): rebuild guidance, no recovery attempt
  it("mode1 (addon load-failed) → rebuild guidance, no manager built", async () => {
    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "load-failed", detail: "NODE_MODULE_VERSION" });
    vi.mocked(createKeyringBackend).mockReturnValue(null);

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    const msg = ctx.lastMessage.toLowerCase();
    expect(msg.includes("rebuild") || msg.includes("engineering:install")).toBe(true);
    expect(vi.mocked(buildMasterKeyManager)).not.toHaveBeenCalled();
  });

  // 2 ─ locked
  it("locked → unlock message, no manager built", async () => {
    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "locked" });
    vi.mocked(createKeyringBackend).mockReturnValue(null);

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/unlock/i);
    expect(vi.mocked(buildMasterKeyManager)).not.toHaveBeenCalled();
  });

  // 3 ─ healthy (ok + key present in keychain)
  it("healthy (ok + keychain has key) → 'nothing to do', no manager built", async () => {
    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "ok" });
    vi.mocked(createKeyringBackend).mockReturnValue(fakeBackend("value") as any);

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/nothing to do/i);
    expect(vi.mocked(buildMasterKeyManager)).not.toHaveBeenCalled();
  });

  // 4 ─ mode2 + recovery succeeds → backend.set called with hex key; success message
  it("mode2 + recovery succeeds → backend.set called once with recovered key hex; reconnected message", async () => {
    const key = Buffer.alloc(32, 7);
    const backend = fakeBackend("not-found");
    const manager = fakeManager({ key });

    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "ok" });
    vi.mocked(createKeyringBackend).mockReturnValue(backend as any);
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);
    vi.mocked(promptMaskedPassphrase).mockResolvedValue({ value: "pw", cancelled: false });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(manager.recoverWithPassphrase).toHaveBeenCalledOnce();
    expect(manager.recoverWithPassphrase).toHaveBeenCalledWith("pw");
    expect(backend.set).toHaveBeenCalledOnce();
    expect(backend.set.mock.calls[0][0]).toBe(KEYRING_SERVICE);
    expect(backend.set.mock.calls[0][1]).toBe(KEYRING_ACCOUNT_MASTER);
    expect(backend.set.mock.calls[0][2]).toBe(key.toString("hex"));
    expect(ctx.lastMessage).toMatch(/reconnected/i);
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 5 ─ mode2 + recoverWithPassphrase throws → "Reconnect failed", no backend.set, zeroize called
  it("mode2 + recoverWithPassphrase throws → 'Reconnect failed', no backend.set, zeroize called", async () => {
    const backend = fakeBackend("not-found");
    const manager = fakeManager({ throwOnRecover: true });

    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "ok" });
    vi.mocked(createKeyringBackend).mockReturnValue(backend as any);
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);
    vi.mocked(promptMaskedPassphrase).mockResolvedValue({ value: "pw", cancelled: false });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/reconnect failed/i);
    expect(backend.set).not.toHaveBeenCalled();
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 6 ─ mode2 + createKeyringBackend returns null (no backend after unlock) → warning, no set, zeroize
  it("mode2 + no backend after unlock → warning about persisting key, zeroize called", async () => {
    const manager = fakeManager({ key: Buffer.alloc(32, 5) });

    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "ok" });
    // null backend: keychainHasKey=false → mode2; and backend is null in the re-store step
    vi.mocked(createKeyringBackend).mockReturnValue(null);
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);
    vi.mocked(promptMaskedPassphrase).mockResolvedValue({ value: "pw", cancelled: false });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    // The "can't be persisted" / rebuild / doctor warning
    expect(ctx.lastMessage).toMatch(/can.?t be persisted|rebuild|doctor/i);
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 7 ─ mode2 + backend.set throws → recovered-but-warn message, zeroize still called
  it("mode2 + backend.set throws → 'writing to the keychain failed' warning, zeroize called", async () => {
    const key = Buffer.alloc(32, 9);
    const backend = {
      get: vi.fn(() => ({ kind: "not-found" as const })),
      set: vi.fn(() => { throw new Error("keychain locked"); }),
      delete: vi.fn(),
    };
    const manager = fakeManager({ key });

    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "ok" });
    vi.mocked(createKeyringBackend).mockReturnValue(backend as any);
    vi.mocked(buildMasterKeyManager).mockReturnValue(manager as any);
    vi.mocked(promptMaskedPassphrase).mockResolvedValue({ value: "pw", cancelled: false });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/writing to the keychain failed|recovered for this session/i);
    expect(manager.zeroize).toHaveBeenCalled();
  });

  // 8 ─ mode2 + user cancels the prompt → "cancelled" message, manager NOT built
  it("mode2 + user cancels prompt → 'cancelled' message, manager not built, no backend.set", async () => {
    const backend = fakeBackend("not-found");

    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "ok" });
    vi.mocked(createKeyringBackend).mockReturnValue(backend as any);
    vi.mocked(promptMaskedPassphrase).mockResolvedValue({ value: "", cancelled: true });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/cancelled/i);
    expect(vi.mocked(buildMasterKeyManager)).not.toHaveBeenCalled();
    expect(backend.set).not.toHaveBeenCalled();
  });

  // 9 ─ mode2 + empty passphrase → "must not be empty", no recover
  it("mode2 + empty passphrase → 'must not be empty' error, manager not built, no backend.set", async () => {
    const backend = fakeBackend("not-found");

    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "ok" });
    vi.mocked(createKeyringBackend).mockReturnValue(backend as any);
    vi.mocked(promptMaskedPassphrase).mockResolvedValue({ value: "", cancelled: false });

    const handler = getHandler();
    const ctx = buildMockCtx();
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/must not be empty/i);
    expect(vi.mocked(buildMasterKeyManager)).not.toHaveBeenCalled();
    expect(backend.set).not.toHaveBeenCalled();
  });

  // 10 ─ mode2 + no masked prompt (ctx.ui.custom absent) → error
  it("mode2 + no masked prompt (no ctx.ui.custom) → error about interactive Pi session", async () => {
    const backend = fakeBackend("not-found");

    vi.mocked(diagnoseKeyring).mockReturnValue({ status: "ok" });
    vi.mocked(createKeyringBackend).mockReturnValue(backend as any);

    const handler = getHandler();
    const ctx = buildMockCtx({ noCustom: true });
    await handler("", ctx);

    expect(ctx.lastMessage).toMatch(/interactive pi session/i);
    expect(vi.mocked(buildMasterKeyManager)).not.toHaveBeenCalled();
    expect(backend.set).not.toHaveBeenCalled();
  });
});
