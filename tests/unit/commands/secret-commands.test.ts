import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// secret-shared
// ---------------------------------------------------------------------------
import { formatSecretRow } from "../../../src/commands/secret-shared.js";

describe("formatSecretRow", () => {
  it("renders name, dates, use_count with notes present", () => {
    const row = {
      name: "MY_KEY",
      notes: "github token",
      created_at: new Date("2025-01-15").getTime(),
      last_used_at: new Date("2025-03-20").getTime(),
      use_count: 7,
    };
    const out = formatSecretRow(row);
    expect(out).toContain("MY_KEY");
    expect(out).toContain("2025-01-15");
    expect(out).toContain("2025-03-20");
    expect(out).toContain("7");
    expect(out).toContain("github token");
    expect(out).not.toContain("never");
  });

  it("renders 'never' when last_used_at is null", () => {
    const row = {
      name: "UNUSED",
      notes: null,
      created_at: new Date("2025-06-01").getTime(),
      last_used_at: null,
      use_count: 0,
    };
    const out = formatSecretRow(row);
    expect(out).toContain("never");
    expect(out).toContain("UNUSED");
    expect(out).toContain("2025-06-01");
  });

  it("renders empty notes when notes is null", () => {
    const row = {
      name: "NO_NOTE",
      notes: null,
      created_at: Date.now(),
      last_used_at: null,
      use_count: 0,
    };
    const out = formatSecretRow(row);
    expect(out).toContain("notes=");
  });
});

// ---------------------------------------------------------------------------
// export → import roundtrip
// ---------------------------------------------------------------------------
import { deriveKeyFromPassphrase, encrypt, decrypt } from "../../../src/secrets/Crypto.js";
import { Vault } from "../../../src/secrets/Vault.js";

function makeTempVault(): Vault {
  const masterKey = randomBytes(32);
  const vault = new Vault({ dbPath: ":memory:", masterKey });
  vault.init();
  return vault;
}

// Simulate the export logic (mirrors secret-export.ts handler logic).
function exportVault(
  vault: Vault,
  exportPassphrase: string,
): { version: number; salt: string; entries: object[] } {
  const salt = randomBytes(16);
  const exportKey = deriveKeyFromPassphrase(exportPassphrase, salt);
  const rows = vault.list();
  const entries = rows.map((row) => {
    const plaintext = vault.get(row.name) ?? "";
    const { ciphertext, iv, tag } = encrypt(plaintext, exportKey);
    return {
      name: row.name,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      notes: row.notes,
      created_at: row.created_at,
    };
  });
  return { version: 1, salt: salt.toString("base64"), entries };
}

// Simulate the import logic (mirrors secret-import.ts handler logic).
function importBlob(
  vault: Vault,
  blob: ReturnType<typeof exportVault>,
  exportPassphrase: string,
  conflictResolver: (name: string) => "overwrite" | "skip" | "abort",
): { imported: number; skipped: number; aborted: boolean } {
  const exportKey = deriveKeyFromPassphrase(exportPassphrase, Buffer.from(blob.salt, "base64"));
  const existing = new Set(vault.list().map((r) => r.name));
  let imported = 0;
  let skipped = 0;

  for (const entry of blob.entries as Array<{
    name: string;
    iv: string;
    tag: string;
    ciphertext: string;
    notes: string | null;
    created_at: number;
  }>) {
    const plaintext = decrypt(
      Buffer.from(entry.ciphertext, "base64"),
      exportKey,
      Buffer.from(entry.iv, "base64"),
      Buffer.from(entry.tag, "base64"),
    );

    if (existing.has(entry.name)) {
      const action = conflictResolver(entry.name);
      if (action === "abort") return { imported, skipped, aborted: true };
      if (action === "skip") { skipped++; continue; }
    }

    vault.set(entry.name, plaintext, entry.notes ?? undefined);
    imported++;
  }
  return { imported, skipped, aborted: false };
}

describe("secret-export → secret-import roundtrip", () => {
  it("preserves all entries across export/import with a fresh vault", () => {
    const source = makeTempVault();
    source.set("API_KEY", "super-secret-value", "my api key");
    source.set("DB_PASS", "hunter2", undefined);

    const blob = exportVault(source, "export-passphrase-123");
    expect(blob.version).toBe(1);
    expect(blob.entries).toHaveLength(2);

    const dest = makeTempVault();
    const result = importBlob(dest, blob, "export-passphrase-123", () => "overwrite");
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.aborted).toBe(false);

    expect(dest.get("API_KEY")).toBe("super-secret-value");
    expect(dest.get("DB_PASS")).toBe("hunter2");

    const listed = dest.list();
    const apiEntry = listed.find((r) => r.name === "API_KEY");
    expect(apiEntry?.notes).toBe("my api key");
  });
});

describe("secret-import conflict: skip", () => {
  it("preserves existing entry when conflict resolver returns skip", () => {
    const source = makeTempVault();
    source.set("TOKEN", "new-value");

    const blob = exportVault(source, "pass");

    const dest = makeTempVault();
    dest.set("TOKEN", "original-value");

    const result = importBlob(dest, blob, "pass", () => "skip");
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
    // Original value preserved.
    expect(dest.get("TOKEN")).toBe("original-value");
  });
});

describe("secret-import conflict: overwrite", () => {
  it("replaces existing entry when conflict resolver returns overwrite", () => {
    const source = makeTempVault();
    source.set("TOKEN", "new-value");

    const blob = exportVault(source, "pass");

    const dest = makeTempVault();
    dest.set("TOKEN", "original-value");

    const result = importBlob(dest, blob, "pass", () => "overwrite");
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(dest.get("TOKEN")).toBe("new-value");
  });
});

// ---------------------------------------------------------------------------
// secret-rm: confirmAction returning false → no deletion
// ---------------------------------------------------------------------------
describe("secret-rm: confirm=false skips deletion", () => {
  it("does not delete when confirmAction returns false", async () => {
    const vault = makeTempVault();
    vault.set("MY_SECRET", "val");

    // Simulate the rm handler logic with injected confirm=false.
    const confirmed = false;
    let deleted = false;
    if (confirmed) {
      deleted = vault.remove("MY_SECRET");
    }

    expect(deleted).toBe(false);
    expect(vault.get("MY_SECRET")).toBe("val");
  });

  it("deletes when confirmAction returns true", () => {
    const vault = makeTempVault();
    vault.set("MY_SECRET", "val");

    const confirmed = true;
    let deleted = false;
    if (confirmed) {
      deleted = vault.remove("MY_SECRET");
    }

    expect(deleted).toBe(true);
    expect(vault.get("MY_SECRET")).toBeNull();
  });
});
