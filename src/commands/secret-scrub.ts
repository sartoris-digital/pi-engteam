import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdir, readFile, writeFile, mkdir, copyFile, stat } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { promptPassphrase } from "../secrets/Passphrase.js";
import { loadVaultForCommand } from "./secret-shared.js";

const DATA_DIR = join(homedir(), ".pi", "engineering-team");
const RUNS_DIR = join(DATA_DIR, "runs");
const SECOND_BRAIN_LOGS = join(DATA_DIR, "second-brain", "logs");

export function registerSecretScrubCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-scrub", {
    description:
      "Vault a leaked secret and retroactively scrub it from all run/log files. Usage: /secret-scrub <NAME>",
    handler: async (args: string, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /secret-scrub <NAME>", "error");
        return;
      }

      let value: string;
      try {
        value = await promptPassphrase({ prompt: `Value to scrub for ${name}: `, confirm: false });
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      if (!value) {
        ctx.ui.notify("Aborted: no value entered.", "error");
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
        vault.set(name, value);
      } finally {
        vault.close();
      }

      const redact = `[REDACTED:${name}]`;
      let filesModified = 0;
      let bytesReplaced = 0;

      // Collect all candidate files.
      const candidates: string[] = [];
      await collectFiles(RUNS_DIR, candidates);
      const today = new Date().toISOString().slice(0, 10);
      candidates.push(join(SECOND_BRAIN_LOGS, `${today}.md`));

      for (const filePath of candidates) {
        let content: string;
        try {
          content = await readFile(filePath, "utf8");
        } catch {
          continue;
        }

        if (!content.includes(value)) continue;

        // Backup before modifying.
        try {
          const runDir = resolveRunDir(filePath);
          if (runDir) {
            const backupDir = join(runDir, ".pre-scrub-backup");
            await mkdir(backupDir, { recursive: true });
            const rel = filePath.slice(runDir.length + 1);
            const backupPath = join(backupDir, rel);
            await mkdir(dirname(backupPath), { recursive: true });
            await copyFile(filePath, backupPath);
          }
        } catch {
          // Backup failure is non-fatal; continue scrubbing.
        }

        const replaced = content.split(value);
        const occurrences = replaced.length - 1;
        bytesReplaced += occurrences * Buffer.byteLength(value, "utf8");
        await writeFile(filePath, replaced.join(redact), "utf8");
        filesModified++;
      }

      ctx.ui.notify(
        [
          `Scrub complete for "${name}":`,
          `  Files modified: ${filesModified}`,
          `  Bytes replaced: ${bytesReplaced}`,
          `Secret has been vaulted. Rotate it externally — the model has already seen the leaked value.`,
        ].join("\n"),
        "info",
      );

      // Emit safety event via pi if available.
      try {
        (pi as any).emit?.("safety:secret_scrub", {
          name,
          files_modified: filesModified,
          bytes_replaced: bytesReplaced,
        });
      } catch {
        // Event emission is best-effort.
      }
    },
  });
}

async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await collectFiles(full, out);
    } else {
      out.push(full);
    }
  }
}

function resolveRunDir(filePath: string): string | null {
  // Find the run directory: RUNS_DIR/<runId>/
  if (!filePath.startsWith(RUNS_DIR)) return null;
  const rel = filePath.slice(RUNS_DIR.length + 1);
  const runId = rel.split("/")[0];
  if (!runId) return null;
  return join(RUNS_DIR, runId);
}
