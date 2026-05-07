import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { randomBytes } from "crypto";
import { promptPassphrase } from "../secrets/Passphrase.js";
import { deriveKeyFromPassphrase, encrypt } from "../secrets/Crypto.js";
import { loadVaultForCommand, confirmAction } from "./secret-shared.js";

export function registerSecretExportCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-export", {
    description: 'Export encrypted vault backup. Usage: /secret-export "<path>"',
    handler: async (args: string, ctx) => {
      const outPath = args.trim().replace(/^"|"$/g, "");
      if (!outPath) {
        ctx.ui.notify('Usage: /secret-export "<path>"', "error");
        return;
      }

      let exportPassphrase: string;
      try {
        exportPassphrase = await promptPassphrase({
          prompt: "Export passphrase: ",
          confirm: true,
        });
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

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
        const rows = vault.list();
        const salt = randomBytes(16);
        const exportKey = deriveKeyFromPassphrase(exportPassphrase, salt);

        // We need raw values — access vault internals via get().
        // vault.get() updates last_used_at; acceptable for export.
        const confirmed = await confirmAction(
          `Export ${rows.length} secret(s) to "${outPath}"?`,
        );
        if (!confirmed) {
          ctx.ui.notify("Aborted.", "info");
          return;
        }

        const entries = rows.map((row) => {
          // vault.get() decrypts plaintext under the master key.
          const plaintext = vault.get(row.name) ?? "";
          const { ciphertext, iv: exportIv, tag: exportTag } = encrypt(plaintext, exportKey);
          return {
            name: row.name,
            iv: exportIv.toString("base64"),
            tag: exportTag.toString("base64"),
            ciphertext: ciphertext.toString("base64"),
            notes: row.notes,
            created_at: row.created_at,
          };
        });

        const blob = JSON.stringify(
          { version: 1, salt: salt.toString("base64"), entries },
          null,
          2,
        );

        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, blob, "utf8");
        ctx.ui.notify(`Exported ${entries.length} secret(s) to "${outPath}".`, "info");
      } finally {
        vault.close();
      }
    },
  });
}
