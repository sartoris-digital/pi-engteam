import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { SecretMeta, VaultRecord, VaultStore } from "./types.js";

type SqliteDatabase = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  close(): void;
};

type SqliteCtor = new (path: string) => SqliteDatabase;

interface Row {
  name: string;
  note: string | null;
  created_at: string;
  rotated_at: string | null;
  scopes: string | null;
  nonce: string;
  ciphertext: string;
  salt: string;
}

const require = createRequire(import.meta.url);

function loadSqlite(): SqliteCtor {
  try {
    return require("better-sqlite3") as SqliteCtor;
  } catch (err) {
    throw new Error(`better-sqlite3 unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function toMeta(row: Row): SecretMeta {
  const meta: SecretMeta = { name: row.name, createdAt: row.created_at };
  if (row.note !== null) meta.note = row.note;
  if (row.rotated_at !== null) meta.rotatedAt = row.rotated_at;
  if (row.scopes !== null) meta.scopes = JSON.parse(row.scopes) as string[];
  return meta;
}

function toRecord(row: Row): VaultRecord {
  return { meta: toMeta(row), nonce: row.nonce, ciphertext: row.ciphertext, salt: row.salt };
}

export class SqliteVaultStore implements VaultStore {
  private readonly db: SqliteDatabase;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const Database = loadSqlite();
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        note TEXT,
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        scopes TEXT,
        nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        salt TEXT NOT NULL
      );
    `);
  }

  put(rec: VaultRecord): void {
    this.db.prepare(`
      INSERT INTO secrets (name, note, created_at, rotated_at, scopes, nonce, ciphertext, salt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        note = excluded.note,
        created_at = excluded.created_at,
        rotated_at = excluded.rotated_at,
        scopes = excluded.scopes,
        nonce = excluded.nonce,
        ciphertext = excluded.ciphertext,
        salt = excluded.salt
    `).run(
      rec.meta.name,
      rec.meta.note ?? null,
      rec.meta.createdAt,
      rec.meta.rotatedAt ?? null,
      rec.meta.scopes ? JSON.stringify(rec.meta.scopes) : null,
      rec.nonce,
      rec.ciphertext,
      rec.salt,
    );
  }

  get(name: string): VaultRecord | undefined {
    const row = this.db.prepare("SELECT * FROM secrets WHERE name = ?").get(name) as Row | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  delete(name: string): boolean {
    return this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name).changes > 0;
  }

  list(): SecretMeta[] {
    const rows = this.db.prepare(
      "SELECT name, note, created_at, rotated_at, scopes FROM secrets ORDER BY name",
    ).all() as Row[];
    return rows.map(toMeta);
  }

  close(): void {
    this.db.close();
  }
}
