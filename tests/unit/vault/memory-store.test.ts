import { describe, expect, it } from "vitest";
import { FakeKeyring } from "../../../src/vault/fake-keyring.js";
import { MemoryVaultStore } from "../../../src/vault/memory-store.js";
import type { SecretMeta, VaultRecord, VaultStore } from "../../../src/vault/types.js";

const rec = (name: string): VaultRecord => ({
  meta: { name, note: "n", createdAt: "2026-09-03T00:00:00.000Z" },
  nonce: "aa",
  ciphertext: "deadbeef",
  salt: "bb",
});

describe("MemoryVaultStore", () => {
  it("satisfies VaultStore and round-trips put/get/delete", () => {
    const store: VaultStore = new MemoryVaultStore();
    const a = rec("ACME_TOKEN");
    store.put(a);
    expect(store.get("ACME_TOKEN")).toEqual(a);
    expect(store.delete("ACME_TOKEN")).toBe(true);
    expect(store.get("ACME_TOKEN")).toBeUndefined();
    expect(store.delete("ACME_TOKEN")).toBe(false);
  });

  it("list never returns ciphertext", () => {
    const store = new MemoryVaultStore();
    store.put(rec("ACME_TOKEN"));
    store.put(rec("OTHER_TOKEN"));
    const listed: SecretMeta[] = store.list();
    expect(listed.map((m) => m.name).sort()).toEqual(["ACME_TOKEN", "OTHER_TOKEN"]);
    expect(JSON.stringify(listed)).not.toContain("deadbeef");
    expect(JSON.stringify(listed)).not.toContain("ciphertext");
    expect(listed.every((m) => !("ciphertext" in m) && !("nonce" in m) && !("salt" in m))).toBe(true);
  });
});

describe("FakeKeyring", () => {
  it("get/set/delete without touching a real keychain", async () => {
    const kr = new FakeKeyring();
    expect(await kr.get("pi-sdlc-factory", "master")).toBeNull();
    await kr.set("pi-sdlc-factory", "master", "sekrit");
    expect(await kr.get("pi-sdlc-factory", "master")).toBe("sekrit");
    await kr.delete("pi-sdlc-factory", "master");
    expect(await kr.get("pi-sdlc-factory", "master")).toBeNull();
  });
});
