// src/secrets/Vault.ts
import Database from "better-sqlite3";
import { encrypt, decrypt } from "./Crypto.js";

type SecretRow = {
  name: string;
  value_enc: Buffer;
  iv: Buffer;
  tag: Buffer;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  notes: string | null;
};

export class Vault {
  private db: Database.Database;
  private masterKey: Buffer;

  constructor(opts: { dbPath: string; masterKey: Buffer }) {
    this.db = new Database(opts.dbPath);
    this.masterKey = opts.masterKey;
  }

  init(): void {
    // WAL mode allows controller + subprocess concurrent reads
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        name         TEXT PRIMARY KEY,
        value_enc    BLOB NOT NULL,
        iv           BLOB NOT NULL,
        tag          BLOB NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count    INTEGER NOT NULL DEFAULT 0,
        notes        TEXT
      );
      CREATE TABLE IF NOT EXISTS vault_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const existing = this.db
      .prepare("SELECT value FROM vault_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!existing) {
      this.db
        .prepare("INSERT INTO vault_meta (key, value) VALUES ('schema_version', '1')")
        .run();
    }
  }

  set(name: string, value: string, notes?: string): void {
    const { ciphertext, iv, tag } = encrypt(value, this.masterKey);
    const now = Date.now();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO secrets (name, value_enc, iv, tag, created_at, last_used_at, use_count, notes)
        VALUES (?, ?, ?, ?, ?, NULL, 0, ?)
      `)
      .run(name, ciphertext, iv, tag, now, notes ?? null);
  }

  get(name: string): string | null {
    const row = this.db
      .prepare("SELECT * FROM secrets WHERE name = ?")
      .get(name) as SecretRow | undefined;
    if (!row) return null;
    const plaintext = decrypt(row.value_enc, this.masterKey, row.iv, row.tag);
    this.db
      .prepare("UPDATE secrets SET use_count = use_count + 1, last_used_at = ? WHERE name = ?")
      .run(Date.now(), name);
    return plaintext;
  }

  list(): Array<{
    name: string;
    notes: string | null;
    created_at: number;
    last_used_at: number | null;
    use_count: number;
  }> {
    return this.db
      .prepare("SELECT name, notes, created_at, last_used_at, use_count FROM secrets ORDER BY name")
      .all() as Array<{
        name: string;
        notes: string | null;
        created_at: number;
        last_used_at: number | null;
        use_count: number;
      }>;
  }

  remove(name: string): boolean {
    const result = this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
    return result.changes > 0;
  }

  // Side-effect-free check that the master key can decrypt at least one row.
  // Used by passphrase recovery — does NOT touch use_count or last_used_at.
  // Empty vault returns true (no validation possible). All-rows-fail returns false.
  verifyDecryptable(): boolean {
    const rows = this.db
      .prepare("SELECT value_enc, iv, tag FROM secrets")
      .all() as Array<{ value_enc: Buffer; iv: Buffer; tag: Buffer }>;
    if (rows.length === 0) return true;
    for (const row of rows) {
      try {
        decrypt(row.value_enc, this.masterKey, row.iv, row.tag);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  close(): void {
    this.db.close();
  }
}
