// src/secrets/Keyring.ts
export interface KeyringBackend {
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
  delete(service: string, account: string): boolean;
}

export const KEYRING_SERVICE = "pi-engineering";
export const KEYRING_ACCOUNT_MASTER = "secrets-master";

export function createKeyringBackend(): KeyringBackend | null {
  try {
    // Dynamic import to catch platform failures at init time, not at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");

    // Smoke-test the backend on first call; throws if unavailable (e.g., headless Linux).
    const probe = new Entry(KEYRING_SERVICE, "__probe__");
    try { probe.getPassword(); } catch (e) {
      // "not found" is fine; any other error means keyring is unavailable
      if (e instanceof Error && !e.message.toLowerCase().includes("not found")) throw e;
    }

    return {
      get(service, account) {
        try {
          const entry = new Entry(service, account);
          return entry.getPassword() ?? null;
        } catch {
          return null;
        }
      },
      set(service, account, value) {
        const entry = new Entry(service, account);
        entry.setPassword(value);
      },
      delete(service, account) {
        try {
          const entry = new Entry(service, account);
          entry.deletePassword();
          return true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return null;
  }
}
