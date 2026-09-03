import { describe, expect, it } from "vitest";
import { FakeKeyring } from "../../../src/vault/fake-keyring.js";
import { MemoryVaultStore } from "../../../src/vault/memory-store.js";
import { KEYRING_ACCOUNT, KEYRING_SERVICE } from "../../../src/vault/keyring.js";
import { assertSecretName, Vault, VaultUnavailableError } from "../../../src/vault/vault.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function makeVault(): Vault {
  return new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring(), now: () => NOW });
}

describe("assertSecretName", () => {
  it("accepts UPPER_SNAKE and repo-scoped names", () => {
    expect(() => assertSecretName("ACME_TOKEN")).not.toThrow();
    expect(() => assertSecretName("repo/acme/ACME_TOKEN")).not.toThrow();
    expect(() => assertSecretName("repo/acme.widgets/GH_TOKEN")).not.toThrow();
  });

  it("rejects lowercase, empty, and extra path segments", () => {
    expect(() => assertSecretName("acme_token")).toThrow();
    expect(() => assertSecretName("A")).toThrow();
    expect(() => assertSecretName("repo/acme/widgets/TOKEN")).toThrow();
    expect(() => assertSecretName("secret:ACME_TOKEN")).toThrow();
  });
});

describe("Vault", () => {
  it("set/list/rm/rotate; list has no value field", async () => {
    const vault = makeVault();
    const meta = await vault.set("ACME_TOKEN", "tok-value", { note: "acme" });
    expect(meta).toEqual({ name: "ACME_TOKEN", note: "acme", createdAt: NOW.toISOString() });
    const listed = await vault.list();
    expect(listed).toEqual([meta]);
    expect(JSON.stringify(listed)).not.toContain("tok-value");
    expect(listed[0] && "value" in listed[0]).toBe(false);
    expect(await vault.getPlaintext("ACME_TOKEN")).toBe("tok-value");

    const rotated = await vault.rotate("ACME_TOKEN", "tok-value-2");
    expect(rotated.createdAt).toBe(NOW.toISOString());
    expect(rotated.rotatedAt).toBe(NOW.toISOString());
    expect(await vault.getPlaintext("ACME_TOKEN")).toBe("tok-value-2");
    expect(JSON.stringify(await vault.list())).not.toContain("tok-value");

    await vault.rm("ACME_TOKEN", { yes: true });
    expect(await vault.list()).toEqual([]);
  });

  it("rm without yes throws", async () => {
    const vault = makeVault();
    await vault.set("ACME_TOKEN", "tok-value");
    await expect(vault.rm("ACME_TOKEN", undefined as unknown as { yes: true })).rejects.toThrow(/yes/);
    expect(await vault.list()).toHaveLength(1);
  });

  it("open with a keyring that cannot store a master key throws VaultUnavailableError", async () => {
    const keyring = new FakeKeyring();
    keyring.get = async () => null;
    keyring.set = async () => {
      throw new Error("keychain locked");
    };
    await expect(Vault.open({ store: new MemoryVaultStore(), keyring })).rejects.toBeInstanceOf(VaultUnavailableError);
    await expect(Vault.open({ store: new MemoryVaultStore(), keyring })).rejects.toMatchObject({
      code: "vault-unavailable",
    });
  });

  it("open reuses an existing master key from the injected keyring", async () => {
    const store = new MemoryVaultStore();
    const keyring = new FakeKeyring();
    const first = await Vault.open({ store, keyring, now: () => NOW });
    await first.set("repo/acme/ACME_TOKEN", "scoped");
    const second = await Vault.open({ store, keyring, now: () => NOW });
    expect(await second.getPlaintext("repo/acme/ACME_TOKEN")).toBe("scoped");
    expect(await keyring.get(KEYRING_SERVICE, KEYRING_ACCOUNT)).not.toBeNull();
  });
});
