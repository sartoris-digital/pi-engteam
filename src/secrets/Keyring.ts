// src/secrets/Keyring.ts
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type KeyringGetResult =
  | { kind: "value"; value: string }
  | { kind: "not-found" }
  | { kind: "error"; error: string };

export interface KeyringBackend {
  get(service: string, account: string): KeyringGetResult;
  set(service: string, account: string, value: string): void;
  delete(service: string, account: string): boolean;
}

export const KEYRING_SERVICE = "pi-engineering";
export const KEYRING_ACCOUNT_MASTER = "secrets-master";

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /not\s*found|no such|does not exist/i.test(err.message);
}

// When loaded from the bundled extension at ~/.pi/agent/extensions/pi-engineering.js
// there is no node_modules to satisfy @napi-rs/keyring's platform-specific binding
// lookup. install.sh / postinstall.mjs copies the host's `keyring.<tag>.node`
// next to the bundle; we point @napi-rs/keyring at it through its official
// NAPI_RS_NATIVE_LIBRARY_PATH env-var hook (node_modules/@napi-rs/keyring/index.js:71).
function configureSideloadedKeyringBinding(): void {
  if (process.env["NAPI_RS_NATIVE_LIBRARY_PATH"]) return;
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    if (!existsSync(moduleDir)) return;
    const match = readdirSync(moduleDir).find((f) => /^keyring\..+\.node$/.test(f));
    if (match) {
      process.env["NAPI_RS_NATIVE_LIBRARY_PATH"] = join(moduleDir, match);
    }
  } catch {
    // best-effort — fall through to the default loader
  }
}

export function createKeyringBackend(): KeyringBackend | null {
  try {
    configureSideloadedKeyringBinding();
    // Dynamic import to catch platform failures at init time, not at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");

    // Probe: any non-"not found" error means the keyring is unreachable.
    const probe = new Entry(KEYRING_SERVICE, "__probe__");
    try { probe.getPassword(); } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }

    return {
      get(service, account): KeyringGetResult {
        try {
          const entry = new Entry(service, account);
          const value = entry.getPassword();
          if (value === null || value === undefined) return { kind: "not-found" };
          return { kind: "value", value };
        } catch (err) {
          if (isNotFoundError(err)) return { kind: "not-found" };
          return {
            kind: "error",
            error: err instanceof Error ? err.message : String(err),
          };
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
