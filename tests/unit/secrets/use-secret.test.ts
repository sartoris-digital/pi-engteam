import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { randomBytes } from "crypto";
import { Vault } from "../../../src/secrets/Vault.js";
import { generateMasterKey } from "../../../src/secrets/Crypto.js";
import { createSecretResolver } from "../../../src/secrets/SecretResolver.js";
import { createUseSecretTool } from "../../../src/secrets/UseSecret.js";

function freshVault(): { vault: Vault; dir: string } {
  const dir = join(tmpdir(), `use-secret-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const vault = new Vault({ dbPath: join(dir, "secrets.db"), masterKey: generateMasterKey() });
  vault.init();
  return { vault, dir };
}

describe("SecretResolver.resolve", () => {
  let vault: Vault;
  let dir: string;

  afterEach(() => {
    try { vault.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("calls vault.get and emits a safety:secret_access event with correct shape", () => {
    ({ vault, dir } = freshVault());
    vault.set("API_KEY", "hunter2");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });

    const value = resolver.resolve("API_KEY", { agent: "worker-1", target: "bash" });

    expect(value).toBe("hunter2");
    expect(emitEvent).toHaveBeenCalledOnce();

    const [call] = emitEvent.mock.calls;
    const evt = call[0] as { category: string; type: string; payload: Record<string, unknown> };
    expect(evt.category).toBe("safety");
    expect(evt.type).toBe("secret_access");
    expect(evt.payload["secret_name"]).toBe("API_KEY");
    expect(evt.payload["agent"]).toBe("worker-1");
    expect(evt.payload["target"]).toBe("bash");
    expect(typeof evt.payload["timestamp"]).toBe("string");
  });

  it("throws when secret is missing and error message identifies the secret name", () => {
    ({ vault, dir } = freshVault());
    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });

    expect(() => resolver.resolve("MISSING_KEY", { agent: "worker-1", target: "bash" }))
      .toThrowError(/MISSING_KEY/);
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("SecretResolver.listNames", () => {
  let vault: Vault;
  let dir: string;

  afterEach(() => {
    try { vault.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns names without values", () => {
    ({ vault, dir } = freshVault());
    vault.set("A", "val-a");
    vault.set("B", "val-b");
    const resolver = createSecretResolver({ vault, emitEvent: vi.fn() });
    const names = resolver.listNames();
    expect(names).toContain("A");
    expect(names).toContain("B");
    expect(names.join(",")).not.toContain("val-a");
    expect(names.join(",")).not.toContain("val-b");
  });
});

describe("UseSecret input validation", () => {
  let vault: Vault;
  let dir: string;

  afterEach(() => {
    try { vault.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeTools() {
    ({ vault, dir } = freshVault());
    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn();
    const tool = createUseSecretTool({ resolver, spawnSubprocess });
    return { tool, spawnSubprocess, emitEvent };
  }

  it("rejects missing name with structured error", async () => {
    const { tool } = makeTools();
    const result = await tool.execute({ target: "bash", command: "echo $SECRET" }) as { error: string };
    expect(result.error).toBeTruthy();
    expect(result).toHaveProperty("hint");
  });

  it("rejects missing command with structured error", async () => {
    const { tool } = makeTools();
    const result = await tool.execute({ name: "KEY", target: "bash" }) as { error: string };
    expect(result.error).toBeTruthy();
    expect(result).toHaveProperty("hint");
  });

  it("rejects target other than bash with structured error", async () => {
    const { tool } = makeTools();
    const result = await tool.execute({ name: "KEY", target: "python", command: "print($SECRET)" }) as { error: string };
    expect(result.error).toMatch(/python/);
    expect(result).toHaveProperty("hint");
  });
});

describe("UseSecret execution", () => {
  let vault: Vault;
  let dir: string;

  afterEach(() => {
    try { vault.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("passes SECRET=<value> in env and the original command to spawnSubprocess", async () => {
    ({ vault, dir } = freshVault());
    vault.set("MY_SECRET", "supersecret");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    await tool.execute({ name: "MY_SECRET", target: "bash", command: "echo $SECRET" });

    expect(spawnSubprocess).toHaveBeenCalledOnce();
    const spawnArg = spawnSubprocess.mock.calls[0][0] as { cmd: string; env: Record<string, string> };
    expect(spawnArg.env["SECRET"]).toBe("supersecret");
    expect(spawnArg.cmd).toBe("echo $SECRET");
    // cmd must contain literal $SECRET, not the resolved value
    expect(spawnArg.cmd).not.toContain("supersecret");
  });

  it("returns spawn output unchanged", async () => {
    ({ vault, dir } = freshVault());
    vault.set("K", "v");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({ stdout: "hello\n", stderr: "warn\n", exitCode: 42 });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    const result = await tool.execute({ name: "K", target: "bash", command: "echo $SECRET" }) as { stdout: string; stderr: string; exitCode: number };
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.exitCode).toBe(42);
  });

  it("emits the safety event exactly once per execute call", async () => {
    ({ vault, dir } = freshVault());
    vault.set("K", "v");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    await tool.execute({ name: "K", target: "bash", command: "true" });
    expect(emitEvent).toHaveBeenCalledOnce();
  });

  it("does not include resolved value in the cmd passed to spawnSubprocess", async () => {
    ({ vault, dir } = freshVault());
    vault.set("TOKEN", "abc123secret");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    await tool.execute({ name: "TOKEN", target: "bash", command: "curl -H 'Auth: $SECRET' https://example.com" });

    const spawnArg = spawnSubprocess.mock.calls[0][0] as { cmd: string; env: Record<string, string> };
    expect(spawnArg.cmd).not.toContain("abc123secret");
    expect(spawnArg.env["SECRET"]).toBe("abc123secret");
  });
});
