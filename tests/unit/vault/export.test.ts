import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeKeyring, MemoryVaultStore, Vault } from "../../../src/vault/index.js";
import { exportVault, importVault, type ExportEnvelope } from "../../../src/vault/export.js";
import { runWithSecret } from "../../../src/vault/inject.js";

function makeVault(): Vault {
  return new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
}

describe("exportVault / importVault", () => {
  it("round-trips names+values; the envelope JSON has no secret substrings", async () => {
    const src = makeVault();
    await src.set("ACME_TOKEN", "s3cret-value-xyz");
    await src.set("repo/acme/GH_TOKEN", "ghp-not-a-real-token-value");
    const envelope = await exportVault(src, "passphrase-for-export");
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.names).toEqual(["secret:ACME_TOKEN", "secret:repo/acme/GH_TOKEN"]);
    const dumped = JSON.stringify(envelope);
    expect(dumped).not.toContain("s3cret-value-xyz");
    expect(dumped).not.toContain("ghp-not-a-real-token-value");

    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-export-"));
    try {
      const path = join(dir, "vault.export.json");
      await writeFile(path, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
      const parsed = JSON.parse(await readFile(path, "utf8")) as ExportEnvelope;
      expect(JSON.stringify(parsed)).not.toContain("s3cret-value-xyz");

      const dest = makeVault();
      const restored = await importVault(dest, parsed, "passphrase-for-export");
      expect(restored).toEqual(["secret:ACME_TOKEN", "secret:repo/acme/GH_TOKEN"]);
      expect(await dest.getPlaintext("ACME_TOKEN")).toBe("s3cret-value-xyz");
      expect(await dest.getPlaintext("repo/acme/GH_TOKEN")).toBe("ghp-not-a-real-token-value");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runWithSecret", () => {
  it("throws when the command would dump the environment", async () => {
    const vault = makeVault();
    await vault.set("ACME_TOKEN", "s3cret");
    await expect(
      runWithSecret({ vault, name: "ACME_TOKEN", command: "printenv", argv: [], timeoutMs: 300_000 }),
    ).rejects.toThrow(/printenv|env|refuse/i);
    await expect(
      runWithSecret({ vault, name: "ACME_TOKEN", command: "env", argv: [], timeoutMs: 1_000 }),
    ).rejects.toThrow(/refuse/i);
    await expect(
      runWithSecret({ vault, name: "ACME_TOKEN", command: "python", argv: ["-c", "import os; print(os.environ)"], timeoutMs: 1_000 }),
    ).rejects.toThrow(/refuse/i);
    await expect(
      runWithSecret({ vault, name: "ACME_TOKEN", command: "pi", argv: ["-p"], timeoutMs: 1_000 }),
    ).rejects.toThrow(/refuse/i);
  });
});
