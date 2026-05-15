import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "fs/promises";
import { deriveKeyFromPassphrase, decrypt } from "../secrets/Crypto.js";
import { loadVaultForCommand } from "./secret-shared.js";

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

type ConflictAction = "overwrite" | "skip" | "abort";

const USAGE =
  "Usage: /secret-import <path> (--passphrase <pp> | --passphrase-from-file <p>) [--on-conflict overwrite|skip|abort]\n" +
  "  --passphrase <pp>               Export passphrase inline.\n" +
  "  --passphrase-from-file <path>   Read the export passphrase from a file (preferred — keeps it out of chat history).\n" +
  "  --on-conflict <action>          What to do when a name already exists in the vault (default: skip). Pi's TUI captures stdin, so an interactive [o/s/a] prompt would hang.";

export function registerSecretImportCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-import", {
    description: "Import secrets from an encrypted export file. Usage: /secret-import <path> (--passphrase <pp> | --passphrase-from-file <p>) [--on-conflict skip|overwrite|abort]",
    handler: async (args: string, ctx) => {
      const parsed = parseImportArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error + "\n\n" + USAGE, "error");
        return;
      }
      const { filePath, passphraseInline, passphraseFromFile, onConflict } = parsed;

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
        ctx.ui.notify("Refusing to decrypt with an empty passphrase.", "error");
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

        // Phase 2: apply conflict policy non-interactively. Pi's TUI consumes
        // stdin so a readline prompt would hang. --on-conflict (default: skip)
        // makes the choice up front and applies uniformly to every conflict.
        const toApply: Array<{ name: string; plaintext: string; notes: string | null }> = [];
        let skipped = 0;
        const conflicts: string[] = [];
        for (const entry of decrypted) {
          if (existing.has(entry.name)) {
            conflicts.push(entry.name);
            if (onConflict === "abort") {
              ctx.ui.notify(
                `Conflict on "${entry.name}" — --on-conflict abort. Vault unchanged.`,
                "info",
              );
              return;
            }
            if (onConflict === "skip") {
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
          [
            `Import complete: ${toApply.length} imported, ${skipped} skipped.`,
            conflicts.length > 0
              ? `Conflicts (${onConflict}): ${conflicts.join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
      } finally {
        vault.close();
      }
    },
  });
}

type ParsedImport = {
  filePath: string;
  passphraseInline: string | undefined;
  passphraseFromFile: string | undefined;
  onConflict: ConflictAction;
  error?: string;
};

function parseImportArgs(raw: string): ParsedImport {
  let s = raw;

  // --on-conflict <action>
  let onConflict: ConflictAction = "skip";
  const onConflictMatch = s.match(/--on-conflict\s+(\w+)/);
  if (onConflictMatch) {
    const value = onConflictMatch[1].toLowerCase();
    if (value !== "overwrite" && value !== "skip" && value !== "abort") {
      return {
        filePath: "",
        passphraseInline: undefined,
        passphraseFromFile: undefined,
        onConflict: "skip",
        error: `Invalid --on-conflict value "${value}" — use overwrite|skip|abort.`,
      };
    }
    onConflict = value;
    s = s.replace(onConflictMatch[0], "").trim();
  }

  // --passphrase-from-file <path>
  let passphraseFromFile: string | undefined;
  const ppFileMatch = s.match(/--passphrase-from-file\s+(\S+)/);
  if (ppFileMatch) {
    passphraseFromFile = ppFileMatch[1];
    s = s.replace(ppFileMatch[0], "").trim();
  }
  // --passphrase <pp>
  let passphraseInline: string | undefined;
  const ppMatch = s.match(/--passphrase\s+(.+?)(?=\s+--\w|\s*$)/);
  if (ppMatch) {
    passphraseInline = ppMatch[1].trim();
    s = s.replace(ppMatch[0], "").trim();
  }

  const filePath = s.trim();
  if (!filePath) {
    return {
      filePath: "",
      passphraseInline,
      passphraseFromFile,
      onConflict,
      error: "Missing required <path> argument.",
    };
  }
  if ((passphraseInline !== undefined) === (passphraseFromFile !== undefined)) {
    return {
      filePath,
      passphraseInline,
      passphraseFromFile,
      onConflict,
      error:
        passphraseInline !== undefined && passphraseFromFile !== undefined
          ? "Pass exactly one of --passphrase or --passphrase-from-file."
          : "Provide the export passphrase via --passphrase or --passphrase-from-file.",
    };
  }
  return { filePath, passphraseInline, passphraseFromFile, onConflict };
}
