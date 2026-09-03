import { describe, expect, it } from "vitest";
import { FakeKeyring } from "../../../src/vault/fake-keyring.js";
import { KEYRING_ACCOUNT, KEYRING_SERVICE, osKeyring } from "../../../src/vault/keyring.js";

describe("osKeyring", () => {
  it("uses service pi-sdlc-factory and account master", () => {
    expect(KEYRING_SERVICE).toBe("pi-sdlc-factory");
    expect(KEYRING_ACCOUNT).toBe("master");
  });

  it("wraps a mock Entry and maps missing passwords to null", async () => {
    const store = new Map<string, string>();
    class Entry {
      constructor(
        private readonly service: string,
        private readonly account: string,
      ) {}
      getPassword(): string | null {
        return store.get(`${this.service}\0${this.account}`) ?? null;
      }
      setPassword(password: string): void {
        store.set(`${this.service}\0${this.account}`, password);
      }
      deletePassword(): boolean {
        return store.delete(`${this.service}\0${this.account}`);
      }
    }
    const kr = osKeyring(() => ({ Entry }));
    expect(await kr.get(KEYRING_SERVICE, KEYRING_ACCOUNT)).toBeNull();
    await kr.set(KEYRING_SERVICE, KEYRING_ACCOUNT, "master-key");
    expect(await kr.get(KEYRING_SERVICE, KEYRING_ACCOUNT)).toBe("master-key");
    await kr.delete(KEYRING_SERVICE, KEYRING_ACCOUNT);
    expect(await kr.get(KEYRING_SERVICE, KEYRING_ACCOUNT)).toBeNull();
  });

  it("throws when the native module cannot load", () => {
    expect(() => osKeyring(() => {
      throw new Error("cannot find module '@napi-rs/keyring'");
    })).toThrow(/unavailable|cannot find module/i);
  });
});

describe("FakeKeyring (keyring unit tests never touch the OS keychain)", () => {
  it("stores values in memory", async () => {
    const kr = new FakeKeyring();
    await kr.set(KEYRING_SERVICE, KEYRING_ACCOUNT, "x");
    expect(await kr.get(KEYRING_SERVICE, KEYRING_ACCOUNT)).toBe("x");
  });
});
