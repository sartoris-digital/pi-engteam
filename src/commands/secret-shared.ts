import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { MasterKeyManager } from "../secrets/MasterKey.js";
import { createKeyringBackend } from "../secrets/Keyring.js";
import { Vault } from "../secrets/Vault.js";
import { promptPassphrase } from "../secrets/Passphrase.js";
import { PasswordInput } from "../ui/PasswordInput.js";

const DATA_DIR = join(homedir(), ".pi", "engineering-team");

export const VAULT_DB_PATH = join(DATA_DIR, "secrets.db");
export const VAULT_SALT_PATH = join(DATA_DIR, "secrets.salt");

export function buildMasterKeyManager(): MasterKeyManager {
  return new MasterKeyManager({
    keyringBackend: createKeyringBackend(),
    saltPath: VAULT_SALT_PATH,
    vaultDbPath: VAULT_DB_PATH,
    promptFn: promptPassphrase,
  });
}

export async function loadVaultForCommand(): Promise<Vault> {
  const manager = buildMasterKeyManager();
  const masterKey = await manager.ensureInitialized();
  const vault = new Vault({ dbPath: VAULT_DB_PATH, masterKey });
  vault.init();
  return vault;
}

export async function confirmAction(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export function formatSecretRow(row: {
  name: string;
  notes: string | null;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
}): string {
  const created = new Date(row.created_at).toISOString().slice(0, 10);
  const lastUsed = row.last_used_at
    ? new Date(row.last_used_at).toISOString().slice(0, 10)
    : "never";
  const notes = row.notes ?? "";
  return `${row.name.padEnd(32)} created=${created}  last_used=${lastUsed}  uses=${row.use_count}  notes=${notes}`;
}

type CustomUi = {
  custom?: <T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: any,
  ) => Promise<T>;
};

// True when the host is a Pi TUI session that can pop overlays (masked input).
export function hasMaskedPrompt(ctx: any): boolean {
  return typeof (ctx?.ui as CustomUi | undefined)?.custom === "function";
}

// Pop a masked single-line passphrase overlay (no echo, no chat-history leak).
// Mirrors /secret-set's input path. Caller must check hasMaskedPrompt(ctx) first.
export async function promptMaskedPassphrase(
  ctx: any,
  label: string,
): Promise<{ value: string; cancelled: boolean }> {
  const customUi = (ctx.ui as CustomUi).custom!;
  return await customUi<{ value: string; cancelled: boolean }>(
    (tui: any, theme: any, _kb: any, done: (r: { value: string; cancelled: boolean }) => void) =>
      new PasswordInput(tui, theme, label, done),
    { overlay: true, overlayOptions: { width: "60%", maxHeight: "30%", anchor: "top-center", offsetY: 2 } },
  );
}
