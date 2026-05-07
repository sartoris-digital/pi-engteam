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

function parseResult(result: { content: Array<{ type: string; text?: string }> }): any {
  const textPart = result.content.find((c) => c.type === "text");
  if (!textPart?.text) return {};
  return JSON.parse(textPart.text);
}

const NOOP_CTX = {} as any;

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

describe("UseSecret tool shape", () => {
  let vault: Vault;
  let dir: string;

  afterEach(() => {
    try { vault.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("matches Pi ToolDefinition contract (name, label, parameters, execute)", () => {
    ({ vault, dir } = freshVault());
    const resolver = createSecretResolver({ vault, emitEvent: vi.fn() });
    const tool = createUseSecretTool({ resolver, spawnSubprocess: vi.fn() });
    expect(tool.name).toBe("UseSecret");
    expect(tool.label).toBe("Use Secret");
    expect(typeof tool.description).toBe("string");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
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

  it("rejects empty name with structured error", async () => {
    const { tool } = makeTools();
    const result = await tool.execute("call-1", { name: "", target: "bash", command: "echo $SECRET" } as any, undefined, undefined, NOOP_CTX);
    const parsed = parseResult(result);
    expect(parsed.error).toBeTruthy();
    expect(parsed.hint).toBeTruthy();
  });

  it("rejects empty command with structured error", async () => {
    const { tool } = makeTools();
    const result = await tool.execute("call-2", { name: "KEY", target: "bash", command: "" } as any, undefined, undefined, NOOP_CTX);
    const parsed = parseResult(result);
    expect(parsed.error).toBeTruthy();
    expect(parsed.hint).toBeTruthy();
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

    await tool.execute("call-3", { name: "MY_SECRET", target: "bash", command: "echo $SECRET" }, undefined, undefined, NOOP_CTX);

    expect(spawnSubprocess).toHaveBeenCalledOnce();
    const spawnArg = spawnSubprocess.mock.calls[0][0] as { cmd: string; env: Record<string, string> };
    expect(spawnArg.env["SECRET"]).toBe("supersecret");
    expect(spawnArg.cmd).toBe("echo $SECRET");
    expect(spawnArg.cmd).not.toContain("supersecret");
  });

  it("returns spawn output when no secret leak", async () => {
    ({ vault, dir } = freshVault());
    vault.set("K", "v");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({ stdout: "hello\n", stderr: "warn\n", exitCode: 42 });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    const result = await tool.execute("call-4", { name: "K", target: "bash", command: "echo $SECRET" }, undefined, undefined, NOOP_CTX);
    const parsed = parseResult(result);
    expect(parsed.stdout).toBe("hello\n");
    expect(parsed.stderr).toBe("warn\n");
    expect(parsed.exitCode).toBe(42);
  });

  it("emits the safety event exactly once per execute call", async () => {
    ({ vault, dir } = freshVault());
    vault.set("K", "v");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    await tool.execute("call-5", { name: "K", target: "bash", command: "true" }, undefined, undefined, NOOP_CTX);
    expect(emitEvent).toHaveBeenCalledOnce();
  });

  it("does not include resolved value in the cmd passed to spawnSubprocess", async () => {
    ({ vault, dir } = freshVault());
    vault.set("TOKEN", "abc123secret");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    await tool.execute("call-6", { name: "TOKEN", target: "bash", command: "curl -H 'Auth: $SECRET' https://example.com" }, undefined, undefined, NOOP_CTX);

    const spawnArg = spawnSubprocess.mock.calls[0][0] as { cmd: string; env: Record<string, string> };
    expect(spawnArg.cmd).not.toContain("abc123secret");
    expect(spawnArg.env["SECRET"]).toBe("abc123secret");
  });
});

describe("UseSecret stdout/stderr scrubbing (CRITICAL #2 regression)", () => {
  let vault: Vault;
  let dir: string;

  afterEach(() => {
    try { vault.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("scrubs plaintext secret from stdout, replacing with [REDACTED:NAME]", async () => {
    ({ vault, dir } = freshVault());
    vault.set("LEAK", "topsecretvalue123");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({
      stdout: "the secret is topsecretvalue123\n",
      stderr: "",
      exitCode: 0,
    });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    const result = await tool.execute("call-7", { name: "LEAK", target: "bash", command: 'echo "the secret is $SECRET"' }, undefined, undefined, NOOP_CTX);
    const parsed = parseResult(result);

    expect(parsed.stdout).not.toContain("topsecretvalue123");
    expect(parsed.stdout).toContain("[REDACTED:LEAK]");
  });

  it("scrubs plaintext secret from stderr, replacing with [REDACTED:NAME]", async () => {
    ({ vault, dir } = freshVault());
    vault.set("LEAK", "topsecretvalue123");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "error happened with topsecretvalue123 in env",
      exitCode: 1,
    });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    const result = await tool.execute("call-8", { name: "LEAK", target: "bash", command: "false" }, undefined, undefined, NOOP_CTX);
    const parsed = parseResult(result);

    expect(parsed.stderr).not.toContain("topsecretvalue123");
    expect(parsed.stderr).toContain("[REDACTED:LEAK]");
  });

  it("scrubs multiple occurrences of the secret in stdout", async () => {
    ({ vault, dir } = freshVault());
    vault.set("DOUBLED", "abc");

    const emitEvent = vi.fn();
    const resolver = createSecretResolver({ vault, emitEvent });
    const spawnSubprocess = vi.fn().mockResolvedValue({
      stdout: "abc and abc and abc",
      stderr: "",
      exitCode: 0,
    });
    const tool = createUseSecretTool({ resolver, spawnSubprocess });

    const result = await tool.execute("call-9", { name: "DOUBLED", target: "bash", command: "x" }, undefined, undefined, NOOP_CTX);
    const parsed = parseResult(result);

    expect(parsed.stdout).toBe("[REDACTED:DOUBLED] and [REDACTED:DOUBLED] and [REDACTED:DOUBLED]");
  });
});
