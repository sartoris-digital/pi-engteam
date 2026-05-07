import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "fs/promises";
import { promptPassphrase } from "../secrets/Passphrase.js";
import { deriveKeyFromPassphrase, decrypt } from "../secrets/Crypto.js";
import { loadVaultForCommand, confirmAction } from "./secret-shared.js";

type ExportEntry = {
  name: string;
  iv: string;
  tag: string;
  ciphertext: string;
  notes: string | null;
  created_at: number;
};

type ExportBlob = {
  version: number;
  salt: string;
  entries: ExportEntry[];
};

export function registerSecretImportCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-import", {
    description: "Import secrets from an encrypted export file. Usage: /secret-import <path>",
    handler: async (args: string, ctx) => {
      const filePath = args.trim();
      if (!filePath) {
        ctx.ui.notify("Usage: /secret-import <path>", "error");
        return;
      }

      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        ctx.ui.notify(
          `Cannot read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      let blob: ExportBlob;
      try {
        blob = JSON.parse(raw) as ExportBlob;
        if (blob.version !== 1 || !Array.isArray(blob.entries) || !blob.salt) {
          throw new Error("Unrecognized export format.");
        }
      } catch (err) {
        ctx.ui.notify(
          `Invalid export file: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      let exportPassphrase: string;
      try {
        exportPassphrase = await promptPassphrase({ prompt: "Export passphrase: ", confirm: false });
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      const salt = Buffer.from(blob.salt, "base64");
      const exportKey = deriveKeyFromPassphrase(exportPassphrase, salt);

      let vault;
      try {
        vault = await loadVaultForCommand();
      } catch (err) {
        ctx.ui.notify(
          `Vault unavailable: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      try {
        const existing = new Set(vault.list().map((r) => r.name));

        // Phase 1: decrypt all entries up front so a partial failure never leaves
        // the vault in a half-imported state. Also reject duplicate names within
        // the export blob — INSERT OR REPLACE would silently lose the earlier entry.
        const decrypted: Array<{ name: string; plaintext: string; notes: string | null }> = [];
        const seenInBlob = new Set<string>();
        for (const entry of blob.entries) {
          if (seenInBlob.has(entry.name)) {
            ctx.ui.notify(
              `Export blob contains duplicate entry "${entry.name}". Aborting — fix the source export and retry.`,
              "error",
            );
            return;
          }
          seenInBlob.add(entry.name);
          let plaintext: string;
          try {
            plaintext = decrypt(
              Buffer.from(entry.ciphertext, "base64"),
              exportKey,
              Buffer.from(entry.iv, "base64"),
              Buffer.from(entry.tag, "base64"),
            );
          } catch {
            ctx.ui.notify(`Decryption failed for "${entry.name}" — wrong passphrase?`, "error");
            return;
          }
          decrypted.push({ name: entry.name, plaintext, notes: entry.notes });
        }

        // Phase 2: resolve all conflicts before any writes.
        const toApply: Array<{ name: string; plaintext: string; notes: string | null }> = [];
        let skipped = 0;
        for (const entry of decrypted) {
          if (existing.has(entry.name)) {
            const action = await promptConflict(entry.name);
            if (action === "abort") {
              ctx.ui.notify("Import aborted — vault unchanged.", "info");
              return;
            }
            if (action === "skip") {
              skipped++;
              continue;
            }
            // overwrite: fall through
          }
          toApply.push(entry);
        }

        // Phase 3: apply all writes after every decision is final.
        for (const entry of toApply) {
          vault.set(entry.name, entry.plaintext, entry.notes ?? undefined);
        }

        ctx.ui.notify(
          `Import complete: ${toApply.length} imported, ${skipped} skipped.`,
          "info",
        );
      } finally {
        vault.close();
      }
    },
  });
}

async function promptConflict(name: string): Promise<"overwrite" | "skip" | "abort"> {
  return new Promise((resolve) => {
    const { createInterface } = require("readline") as typeof import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `Secret "${name}" already exists. [o]verwrite / [s]kip / [a]bort? `,
      (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        if (a === "o" || a === "overwrite") resolve("overwrite");
        else if (a === "a" || a === "abort") resolve("abort");
        else resolve("skip");
      },
    );
  });
}
