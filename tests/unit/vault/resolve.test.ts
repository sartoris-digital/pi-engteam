import { describe, expect, it } from "vitest";
import { FakeKeyring } from "../../../src/vault/fake-keyring.js";
import { MemoryVaultStore } from "../../../src/vault/memory-store.js";
import { injectHostEnv } from "../../../src/vault/host-env.js";
import { resolveSecretRef, SECRET_REF } from "../../../src/vault/resolve.js";
import { Vault } from "../../../src/vault/vault.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

async function vaultWith(entries: Record<string, string>): Promise<Vault> {
  const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring(), now: () => NOW });
  for (const [name, value] of Object.entries(entries)) await vault.set(name, value);
  return vault;
}

describe("SECRET_REF", () => {
  it("matches global and repo-scoped refs", () => {
    expect(SECRET_REF.test("secret:ACME_TOKEN")).toBe(true);
    expect(SECRET_REF.test("secret:repo/acme/ACME_TOKEN")).toBe(true);
    expect(SECRET_REF.test("ACME_TOKEN")).toBe(false);
    expect(SECRET_REF.test("secret:acme_token")).toBe(false);
  });
});

describe("resolveSecretRef", () => {
  it("resolves secret:ACME_TOKEN and prefers repo/<slug>/<NAME> then NAME", async () => {
    const vault = await vaultWith({
      ACME_TOKEN: "global-token",
      "repo/acme/ACME_TOKEN": "repo-token",
    });
    expect(await resolveSecretRef("secret:ACME_TOKEN", vault)).toBe("global-token");
    expect(await resolveSecretRef("secret:ACME_TOKEN", vault, "acme")).toBe("repo-token");
    expect(await resolveSecretRef("secret:repo/acme/ACME_TOKEN", vault)).toBe("repo-token");
    expect(await resolveSecretRef("secret:ACME_TOKEN", vault, "other")).toBe("global-token");
  });

  it("throws on a bad ref or missing secret", async () => {
    const vault = await vaultWith({ ACME_TOKEN: "global-token" });
    await expect(resolveSecretRef("not-a-ref", vault)).rejects.toThrow(/secret:/);
    await expect(resolveSecretRef("secret:MISSING_TOKEN", vault)).rejects.toThrow(/not found/);
  });
});

describe("injectHostEnv", () => {
  it("copies base and sets secrets without mutating the parent env", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/h" };
    const out = injectHostEnv(base, { GH_TOKEN: "injected", ACME_TOKEN: "tok" });
    expect(out.PATH).toBe("/bin");
    expect(out.GH_TOKEN).toBe("injected");
    expect(out.ACME_TOKEN).toBe("tok");
    expect(base).not.toHaveProperty("GH_TOKEN");
    expect(base).not.toHaveProperty("ACME_TOKEN");
  });
});
