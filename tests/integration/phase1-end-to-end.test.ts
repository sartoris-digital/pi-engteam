// tests/integration/phase1-end-to-end.test.ts
//
// Happy-path integration test for the full Phase 1 secrets + rate-limit surface.
// Does not spin up a real Pi extension — exercises modules directly.

import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { randomBytes } from "crypto";
import { Vault } from "../../src/secrets/Vault.js";
import { MasterKeyManager } from "../../src/secrets/MasterKey.js";
import { type KeyringBackend, KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER } from "../../src/secrets/Keyring.js";
import { createSecretResolver } from "../../src/secrets/SecretResolver.js";
import { createUseSecretTool } from "../../src/secrets/UseSecret.js";
import { processInput } from "../../src/secrets/Integration.js";
import { DEFAULT_PATTERNS } from "../../src/secrets/patterns.js";
import { RateLimitGuard } from "../../src/rateLimit/RateLimitGuard.js";
import type { RateLimitConfig } from "../../src/rateLimit/config.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const d = join(tmpdir(), `phase1-e2e-${randomBytes(6).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeMockKeyring(): KeyringBackend {
  const store = new Map<string, string>();
  return {
    get: (service, account) => {
      const v = store.get(`${service}:${account}`);
      return v === undefined ? { kind: "not-found" } : { kind: "value", value: v };
    },
    set: (service, account, value) => { store.set(`${service}:${account}`, value); },
    delete: (service, account) => {
      const key = `${service}:${account}`;
      const had = store.has(key);
      store.delete(key);
      return had;
    },
  };
}

async function makeVaultFromKeyring(dir: string): Promise<{ vault: Vault; masterKey: Buffer }> {
  const keyring = makeMockKeyring();
  const mgr = new MasterKeyManager({
    keyringBackend: keyring,
    saltPath: join(dir, "secrets.salt"),
    vaultDbPath: join(dir, "secrets.db"),
  });
  const masterKey = await mgr.ensureInitialized();
  const vault = new Vault({ dbPath: join(dir, "secrets.db"), masterKey });
  vault.init();
  return { vault, masterKey };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Phase 1 end-to-end: MasterKeyManager + Vault round-trip", () => {
  let dir: string;
  let vault: Vault;

  afterEach(() => {
    try { vault?.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("stores and retrieves a secret through the full crypto stack", async () => {
    dir = makeTmpDir();
    ({ vault } = await makeVaultFromKeyring(dir));

    vault.set("DB_PASSWORD", "s3cr3t-db-pass");
    const retrieved = vault.get("DB_PASSWORD");
    expect(retrieved).toBe("s3cr3t-db-pass");
  });

  it("second MasterKeyManager with same keyring returns the same key", async () => {
    dir = makeTmpDir();
    const keyring = makeMockKeyring();
    const dbPath = join(dir, "secrets.db");
    const saltPath = join(dir, "secrets.salt");

    const mgr1 = new MasterKeyManager({ keyringBackend: keyring, saltPath, vaultDbPath: dbPath });
    const key1 = await mgr1.ensureInitialized();

    const mgr2 = new MasterKeyManager({ keyringBackend: keyring, saltPath, vaultDbPath: dbPath });
    const key2 = await mgr2.ensureInitialized();

    expect(key1.equals(key2)).toBe(true);

    vault = new Vault({ dbPath, masterKey: key1 });
    vault.init();
  });
});

describe("Phase 1 end-to-end: SecretResolver emits correct event shape", () => {
  let dir: string;
  let vault: Vault;

  afterEach(() => {
    try { vault?.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("emits safety:secret_access with name, agent, target, timestamp", async () => {
    dir = makeTmpDir();
    ({ vault } = await makeVaultFromKeyring(dir));
    vault.set("API_TOKEN", "tok-abc123");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });

    const value = resolver.resolve("API_TOKEN", { agent: "implementer", target: "bash" });

    expect(value).toBe("tok-abc123");
    expect(emitEvent).toHaveBeenCalledOnce();

    const evt = emitEvent.mock.calls[0][0] as { category: string; type: string; payload: Record<string, unknown> };
    expect(evt.category).toBe("safety");
    expect(evt.type).toBe("secret_access");
    expect(evt.payload["secret_name"]).toBe("API_TOKEN");
    expect(evt.payload["agent"]).toBe("implementer");
    expect(evt.payload["target"]).toBe("bash");
    expect(typeof evt.payload["timestamp"]).toBe("string");
  });
});

describe("Phase 1 end-to-end: UseSecret tool env injection", () => {
  let dir: string;
  let vault: Vault;

  afterEach(() => {
    try { vault?.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("passes SECRET=<value> in env and the original command string unchanged", async () => {
    dir = makeTmpDir();
    ({ vault } = await makeVaultFromKeyring(dir));
    vault.set("MY_TOKEN", "plaintext-value");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({ stdout: "done\n", stderr: "", exitCode: 0 });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    const result = await tool.execute("call-1", {
      name: "MY_TOKEN",
      target: "bash",
      command: "curl -H 'Authorization: Bearer $SECRET' https://api.example.com",
    }, undefined, undefined, {} as any);

    const textPart = result.content.find((c: any) => c.type === "text") as { type: "text"; text: string } | undefined;
    const parsed = JSON.parse(textPart?.text ?? "{}") as { stdout: string; stderr: string; exitCode: number };
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe("done\n");

    const spawnArg = spawnSubprocess.mock.calls[0][0] as { cmd: string; env: Record<string, string> };
    expect(spawnArg.env["SECRET"]).toBe("plaintext-value");
    expect(spawnArg.cmd).toContain("$SECRET");
    expect(spawnArg.cmd).not.toContain("plaintext-value");
  });
});

describe("Phase 1 end-to-end: Integration.processInput vaults and rewrites", () => {
  let dir: string;
  let vault: Vault;

  afterEach(() => {
    try { vault?.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("detects sk-ant-... token, vaults it, and rewrites the string with placeholder", async () => {
    dir = makeTmpDir();
    ({ vault } = await makeVaultFromKeyring(dir));

    // Construct a fake Anthropic API key that matches the pattern (sk-ant- + 20+ chars)
    const fakeToken = `sk-ant-${"x".repeat(24)}`;
    const input = `Please use this key: ${fakeToken} for the API call.`;

    const emitEvent = vi.fn();
    const result = await processInput(
      input,
      {
        enabled: true,
        interactivePrompt: false,
        onSkipBehavior: "warn",
        entropyEnabled: false,
        vault,
        emitEvent,
        loadPatterns: () => DEFAULT_PATTERNS,
      },
      async (match) => ({ choice: "vault" as const, vaultName: match.pattern.suggestedName }),
    );

    expect(result.action).toBe("vault-and-rewrite");
    if (result.action === "vault-and-rewrite") {
      expect(result.rewritten).toContain("${SECRET:ANTHROPIC_API_KEY}");
      expect(result.rewritten).not.toContain(fakeToken);
      expect(result.vaulted[0]?.name).toBe("ANTHROPIC_API_KEY");
      expect(result.vaulted[0]?.original).toBe(fakeToken);
    }

    // Verify the secret was actually persisted in the vault
    const stored = vault.get("ANTHROPIC_API_KEY");
    expect(stored).toBe(fakeToken);
  });
});

describe("Phase 1 end-to-end: RateLimitGuard saturation events", () => {
  it("fires warn event when saturation crosses warnThresholdPct", () => {
    const config: RateLimitConfig = {
      enabled: true,
      maxConcurrent: 10,
      warnThresholdPct: 50,
      pauseThresholdPct: 90,
      providers: [
        { provider: "anthropic", rpmCeiling: 2, tpmCeiling: 10000, windowMs: 60_000 },
      ],
    };

    const events: Array<{ kind: string; provider: string; saturationPct: number }> = [];
    const guard = new RateLimitGuard(config, (evt) => {
      events.push({ kind: evt.kind, provider: evt.provider, saturationPct: evt.saturationPct });
    });

    // First acquire: 1/2 RPM = 50% — crosses warnThresholdPct exactly
    const t1 = guard.acquire("anthropic");
    expect(t1.ok).toBe(true);

    // Second acquire: 2/2 RPM = 100% — should trigger warn or pause
    const t2 = guard.acquire("anthropic");
    expect(t2.ok).toBe(true);

    // At least one saturation event should have fired
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].provider).toBe("anthropic");
    expect(events[0].saturationPct).toBeGreaterThanOrEqual(50);
  });

  it("blocks acquire when RPM ceiling is reached", () => {
    const config: RateLimitConfig = {
      enabled: true,
      maxConcurrent: 10,
      warnThresholdPct: 80,
      pauseThresholdPct: 95,
      providers: [
        { provider: "openai", rpmCeiling: 1, tpmCeiling: 10000, windowMs: 60_000 },
      ],
    };

    const guard = new RateLimitGuard(config);
    const t1 = guard.acquire("openai");
    expect(t1.ok).toBe(true);

    const t2 = guard.acquire("openai");
    expect(t2.ok).toBe(false);
    if (!t2.ok) {
      expect(t2.reason).toBe("rpm");
      expect(t2.retryAfterMs).toBeGreaterThan(0);
    }
  });
});
