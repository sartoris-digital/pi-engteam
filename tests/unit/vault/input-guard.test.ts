import { describe, expect, it } from "vitest";
import { FakePi } from "../../helpers/fake-pi.js";
import { fakePathEnv } from "../../helpers/run-context.js";
import { controllerHardBlock } from "../../../src/safety/layer-a.js";
import { FakeKeyring } from "../../../src/vault/fake-keyring.js";
import { installInputGuard, looksLikeSecret } from "../../../src/vault/input-guard.js";
import { MemoryVaultStore } from "../../../src/vault/memory-store.js";
import { probeVault, Vault } from "../../../src/vault/vault.js";

const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const LONG_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn+/==";

describe("looksLikeSecret", () => {
  it("treats ghp_ tokens and long base64 as secrets", () => {
    expect(looksLikeSecret(`token ${GHP}`)).toBe(true);
    expect(looksLikeSecret(`blob ${LONG_B64} end`)).toBe(true);
  });

  it("does not flag ordinary task text", () => {
    expect(looksLikeSecret("add a greeting helper")).toBe(false);
  });
});

describe("installInputGuard", () => {
  it("blocks likely secrets when the vault is unopenable", async () => {
    const fake = new FakePi();
    const notes: string[] = [];
    installInputGuard(fake.asPi(), null);
    const blocked = await fake.emit("input", { text: `here ${GHP}` }, {
      ui: { notify: (msg: string) => notes.push(msg) },
    });
    expect(blocked).toEqual({ action: "handled" });
    expect(notes.join(" ")).toMatch(/vault is unavailable|repair/i);
    const ok = await fake.emit("input", { text: "add a greeting helper" }, {
      ui: { notify: (msg: string) => notes.push(msg) },
    });
    expect(ok).toEqual({ action: "continue" });
  });

  it("blocks likely secrets when the vault is open and offers /factory secret set", async () => {
    const fake = new FakePi();
    const notes: string[] = [];
    const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
    installInputGuard(fake.asPi(), vault);
    const blocked = await fake.emit("input", { text: GHP }, {
      ui: { notify: (msg: string) => notes.push(msg) },
    });
    expect(blocked).toEqual({ action: "handled" });
    expect(notes.join(" ")).toMatch(/\/factory secret set/);
  });
});

describe("probeVault", () => {
  it("reports ok with an injected store and keyring", async () => {
    const result = await probeVault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/vault\.sqlite$/);
  });

  it("reports failure when the keyring cannot hold a master key", async () => {
    const keyring = new FakeKeyring();
    keyring.get = async () => null;
    keyring.set = async () => {
      throw new Error("keychain locked");
    };
    const result = await probeVault({ store: new MemoryVaultStore(), keyring });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/keychain locked|unavailable/i);
  });
});

describe("controllerHardBlock", () => {
  it("still blocks vault.sqlite", () => {
    const env = fakePathEnv();
    const vault = controllerHardBlock("read", { path: `${env.factoryHome}/vault.sqlite` }, env);
    expect(vault).toEqual({ block: true, layer: "A", reason: expect.stringMatching(/^\[Layer A\]/) });
  });
});
