import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "fs/promises";
import { loadVaultForCommand } from "./secret-shared.js";

const USAGE =
  "Usage: /secret-rotate <NAME> (--value <secret> | --from-file <path>)\n" +
  "  --value <secret>        Set the new value inline.\n" +
  "  --from-file <path>      Read the new value from a file (preferred for secrets that should not enter chat history).\n" +
  "Exactly one of --value or --from-file must be provided.";

export function registerSecretRotateCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-rotate", {
    description: "Replace the value of an existing secret. Usage: /secret-rotate <NAME> (--value <secret> | --from-file <path>)",
    handler: async (args: string, ctx) => {
      // Same rationale as /secret-set: Pi's TUI consumes stdin, so a
      // raw readline prompt would hang. Take the new value via
      // --value or --from-file.
      const parsed = parseArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error + "\n\n" + USAGE, "error");
        return;
      }
      const { name, valueInline, fromFile } = parsed;

      let value: string;
      if (valueInline !== undefined) {
        value = valueInline;
      } else if (fromFile !== undefined) {
        try {
          value = (await readFile(fromFile, "utf8")).replace(/\n$/, "");
        } catch (err) {
          ctx.ui.notify(
            `Failed to read --from-file path: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          return;
        }
      } else {
        ctx.ui.notify(USAGE, "error");
        return;
      }
      if (!value) {
        ctx.ui.notify("Refusing to rotate to an empty secret value.", "error");
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
        const existing = vault.list().find((r) => r.name === name);
        if (!existing) {
          ctx.ui.notify(`Secret "${name}" not found. Use /secret-set to create it.`, "error");
          return;
        }
        vault.set(name, value, existing.notes ?? undefined);
        ctx.ui.notify(`Secret "${name}" rotated.`, "info");
      } finally {
        vault.close();
      }
    },
  });
}

type ParsedArgs = {
  name: string;
  valueInline: string | undefined;
  fromFile: string | undefined;
  error?: string;
};

function parseArgs(raw: string): ParsedArgs {
  let s = raw;
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
  if (!name) return { name: "", valueInline, fromFile, error: "Missing required <NAME> argument." };
  if (valueInline !== undefined && fromFile !== undefined) {
    return { name, valueInline, fromFile, error: "Pass exactly one of --value or --from-file, not both." };
  }
  if (valueInline === undefined && fromFile === undefined) {
    return { name, valueInline, fromFile, error: "Provide the new value via --value or --from-file." };
  }
  return { name, valueInline, fromFile };
}
