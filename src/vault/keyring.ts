import { createRequire } from "node:module";
import type { KeyringPort } from "./types.js";

export const KEYRING_SERVICE = "pi-sdlc-factory";
export const KEYRING_ACCOUNT = "master";

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface KeyringModule {
  Entry: new (service: string, username: string) => KeyringEntry;
}

const require = createRequire(import.meta.url);

function defaultLoad(): KeyringModule {
  if (process.env.VITEST) {
    throw new Error("native keyring is disabled in tests");
  }
  return require("@napi-rs/keyring") as KeyringModule;
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /not\s*found|no such|does not exist|no password/i.test(err.message);
}

export function osKeyring(load: () => KeyringModule = defaultLoad): KeyringPort {
  let mod: KeyringModule;
  try {
    mod = load();
  } catch (err) {
    throw new Error(`os keyring unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { Entry } = mod;
  return {
    async get(service, account) {
      try {
        const value = new Entry(service, account).getPassword();
        return value ?? null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async set(service, account, secret) {
      new Entry(service, account).setPassword(secret);
    },
    async delete(service, account) {
      try {
        new Entry(service, account).deletePassword();
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    },
  };
}
