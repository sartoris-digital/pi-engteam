import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdir, readFile, writeFile, mkdir, copyFile, stat } from "fs/promises";
import { readFile as readFileText } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { loadVaultForCommand } from "./secret-shared.js";

const DATA_DIR = join(homedir(), ".pi", "engineering-team");
const RUNS_DIR = join(DATA_DIR, "runs");
const SECOND_BRAIN_LOGS = join(DATA_DIR, "second-brain", "logs");

const SCRUB_USAGE =
  "Usage: /secret-scrub <NAME> (--value <leaked-value> | --from-file <path>)\n" +
  "  --value <leaked-value>  Inline value to vault + scrub.\n" +
  "  --from-file <path>      Read the leaked value from a file (preferred for secrets that should not enter chat history).";

export function registerSecretScrubCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-scrub", {
    description:
      "Vault a leaked secret and retroactively scrub it from all run/log files. Usage: /secret-scrub <NAME> (--value <v> | --from-file <p>)",
    handler: async (args: string, ctx) => {
      // Pi's TUI captures stdin, so a readline-based "Value to scrub:"
      // prompt would hang. Take the value via --value / --from-file.
      let s = args;
      let valueInline: string | undefined;
      const valueMatch = s.match(/--value\s+(.+?)(?=\s+--from-file\s|\s*$)/);
      if (valueMatch) {
        valueInline = valueMatch[1].trim();
        s = s.replace(valueMatch[0], "").trim();
      }
      let fromFile: string | undefined;
      const fileMatch = s.match(/--from-file\s+(\S+)/);
      if (fileMatch) {
        fromFile = fileMatch[1];
        s = s.replace(fileMatch[0], "").trim();
      }
      const name = s.trim();
      if (!name) {
        ctx.ui.notify(SCRUB_USAGE, "error");
        return;
      }
      if ((valueInline !== undefined) === (fromFile !== undefined)) {
        ctx.ui.notify(
          (valueInline !== undefined && fromFile !== undefined)
            ? "Pass exactly one of --value or --from-file, not both.\n\n" + SCRUB_USAGE
            : "Provide the leaked value via --value or --from-file.\n\n" + SCRUB_USAGE,
          "error",
        );
        return;
      }

      let value: string;
      if (valueInline !== undefined) {
        value = valueInline;
      } else {
        try {
          value = (await readFileText(fromFile!, "utf8")).replace(/\n$/, "");
        } catch (err) {
          ctx.ui.notify(
            `Failed to read --from-file path: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          return;
        }
      }
      if (!value) {
        ctx.ui.notify("Refusing to scrub an empty value.", "error");
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
      // Walk every second-brain log, not just today's — secrets leaked yesterday
      // would otherwise persist forever.
      await collectFiles(SECOND_BRAIN_LOGS, candidates);
      // Active Pi session JSONL is where most leaked user content actually lives.
      try {
        const activeSession = ctx.sessionManager?.getSessionFile?.();
        if (activeSession) candidates.push(activeSession);
      } catch {
        // ctx.sessionManager may be unavailable in some invocation paths.
      }

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
