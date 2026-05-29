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

export type KeyringDiagnosis = {
  status: "ok" | "load-failed" | "locked" | "unavailable";
  detail?: string;
};

export type ReconnectMode = "mode1" | "locked" | "healthy" | "mode2";

// Classify a thrown keyring error into an actionable status. "load-failed" means
// the native addon could not be loaded (ABI mismatch / missing binary) — Mode 1,
// fixed by rebuilding via engineering:install. "locked" means the OS keychain
// denied access. Everything else is "unavailable".
export function classifyKeyringError(err: unknown): KeyringDiagnosis {
  const msg = err instanceof Error ? err.message : String(err);
  if (/NODE_MODULE_VERSION|was compiled against|cannot find module|module did not self-register|dlopen|invalid ELF|symbol not found/i.test(msg)) {
    return { status: "load-failed", detail: msg };
  }
  if (/locked|auth.*fail|errSecAuthFailed|access denied|permission denied|interaction is not allowed/i.test(msg)) {
    return { status: "locked", detail: msg };
  }
  return { status: "unavailable", detail: msg };
}

// Probe the keyring addon without mutating anything. Used only by /secret-reconnect
// and doctor — the createKeyringBackend() null contract is unchanged for the hot path.
export function diagnoseKeyring(): KeyringDiagnosis {
  try {
    configureSideloadedKeyringBinding();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
    const probe = new Entry(KEYRING_SERVICE, "__probe__");
    try {
      probe.getPassword();
    } catch (e) {
      if (!isNotFoundError(e)) return classifyKeyringError(e);
    }
    return { status: "ok" };
  } catch (e) {
    return classifyKeyringError(e);
  }
}

// Pure decision: given a keyring diagnosis and whether the keychain currently
// holds the master key, decide what /secret-reconnect should do.
export function decideReconnectMode(diag: KeyringDiagnosis, keychainHasKey: boolean): ReconnectMode {
  if (diag.status === "load-failed") return "mode1";
  if (diag.status === "locked") return "locked";
  if (diag.status === "ok" && keychainHasKey) return "healthy";
  return "mode2";
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
