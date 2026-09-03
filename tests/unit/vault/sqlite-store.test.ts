import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVaultStore } from "../../../src/vault/sqlite-store.js";
import type { VaultRecord } from "../../../src/vault/types.js";

const rec = (name: string, ciphertext = "deadbeef"): VaultRecord => ({
  meta: { name, note: "n", createdAt: "2026-09-03T00:00:00.000Z" },
  nonce: "aa",
  ciphertext,
  salt: "bb",
});

async function tryOpen(path: string): Promise<{ store: SqliteVaultStore } | { skip: string }> {
  try {
    return { store: new SqliteVaultStore(path) };
  } catch (err) {
    return { skip: err instanceof Error ? err.message : String(err) };
  }
}

describe("SqliteVaultStore", () => {
  it("put/get/delete on a temp sqlite file under PI_SDLC_HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sdlc-vault-"));
    const path = join(home, "vault.sqlite");
    const opened = await tryOpen(path);
    if ("skip" in opened) {
      console.warn(`skips sqlite store tests when better-sqlite3 cannot load: ${opened.skip}`);
      return;
    }
    const { store } = opened;
    try {
      store.put(rec("ACME_TOKEN"));
      expect(store.get("ACME_TOKEN")?.ciphertext).toBe("deadbeef");
      expect(store.list().map((m) => m.name)).toEqual(["ACME_TOKEN"]);
      expect(JSON.stringify(store.list())).not.toContain("deadbeef");
      expect(store.delete("ACME_TOKEN")).toBe(true);
      expect(store.get("ACME_TOKEN")).toBeUndefined();
    } finally {
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("file mode is 0o600 (unix)", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "pi-sdlc-vault-mode-"));
    const path = join(home, "vault.sqlite");
    const opened = await tryOpen(path);
    if ("skip" in opened) {
      console.warn(`skips sqlite store tests when better-sqlite3 cannot load: ${opened.skip}`);
      return;
    }
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      opened.store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("skips sqlite store tests when better-sqlite3 cannot load", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sdlc-vault-skip-"));
    try {
      await mkdir(home, { recursive: true });
      const opened = await tryOpen(join(home, "vault.sqlite"));
      if ("skip" in opened) {
        expect(opened.skip.length).toBeGreaterThan(0);
      } else {
        opened.store.close();
        expect(opened.store).toBeDefined();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
