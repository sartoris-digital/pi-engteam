import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { randomBytes } from "crypto";
import { deriveKeyFromPassphrase, encrypt } from "../secrets/Crypto.js";
import { loadVaultForCommand } from "./secret-shared.js";

const USAGE =
  'Usage: /secret-export "<path>" (--passphrase <pp> | --passphrase-from-file <path>) --yes\n' +
  "  --passphrase <pp>               Export passphrase inline.\n" +
  "  --passphrase-from-file <path>   Read the export passphrase from a file (preferred — keeps it out of chat history).\n" +
  "  --yes                           Required confirmation flag (Pi's TUI captures stdin, so no y/N prompt).";

export function registerSecretExportCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-export", {
    description: 'Export encrypted vault backup. Usage: /secret-export "<path>" (--passphrase <pp> | --passphrase-from-file <path>) --yes',
    handler: async (args: string, ctx) => {
      const parsed = parseExportArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error + "\n\n" + USAGE, "error");
        return;
      }
      const { outPath, passphraseInline, passphraseFromFile, confirmed } = parsed;
      if (!confirmed) {
        ctx.ui.notify(`Refusing to export without --yes. Pass --yes to proceed.`, "error");
        return;
      }

      let exportPassphrase: string;
      if (passphraseInline !== undefined) {
        exportPassphrase = passphraseInline;
      } else {
        try {
          exportPassphrase = (await readFile(passphraseFromFile!, "utf8")).replace(/\n$/, "");
        } catch (err) {
          ctx.ui.notify(
            `Failed to read --passphrase-from-file: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          return;
        }
      }
      if (!exportPassphrase) {
        ctx.ui.notify("Refusing to encrypt the export with an empty passphrase.", "error");
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

type ParsedExport = {
  outPath: string;
  passphraseInline: string | undefined;
  passphraseFromFile: string | undefined;
  confirmed: boolean;
  error?: string;
};

function parseExportArgs(raw: string): ParsedExport {
  let s = raw;
  const confirmed = / --yes\b/.test(" " + s);
  s = s.replace(/(^|\s)--yes(\s|$)/, " ").trim();

  let passphraseFromFile: string | undefined;
  const ppFileMatch = s.match(/--passphrase-from-file\s+(\S+)/);
  if (ppFileMatch) {
    passphraseFromFile = ppFileMatch[1];
    s = s.replace(ppFileMatch[0], "").trim();
  }
  let passphraseInline: string | undefined;
  const ppMatch = s.match(/--passphrase\s+(.+?)(?=\s+--\w|\s*$)/);
  if (ppMatch) {
    passphraseInline = ppMatch[1].trim();
    s = s.replace(ppMatch[0], "").trim();
  }
  const outPath = s.trim().replace(/^"|"$/g, "");
  if (!outPath) return { outPath: "", passphraseInline, passphraseFromFile, confirmed, error: "Missing required <path>." };
  if ((passphraseInline !== undefined) === (passphraseFromFile !== undefined)) {
    return {
      outPath,
      passphraseInline,
      passphraseFromFile,
      confirmed,
      error: (passphraseInline !== undefined && passphraseFromFile !== undefined)
        ? "Pass exactly one of --passphrase or --passphrase-from-file."
        : "Provide the export passphrase via --passphrase or --passphrase-from-file.",
    };
  }
  return { outPath, passphraseInline, passphraseFromFile, confirmed };
}
