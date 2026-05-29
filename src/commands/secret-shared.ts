import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { MasterKeyManager } from "../secrets/MasterKey.js";
import { createKeyringBackend } from "../secrets/Keyring.js";
import { Vault } from "../secrets/Vault.js";
import { promptPassphrase } from "../secrets/Passphrase.js";

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
