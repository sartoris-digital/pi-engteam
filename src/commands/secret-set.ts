import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "fs/promises";
import { loadVaultForCommand } from "./secret-shared.js";

const USAGE =
  'Usage: /secret-set <NAME> [--note "..."] (--value <secret> | --from-file <path>)\n' +
  '  --value <secret>        Set the value inline.\n' +
  '  --from-file <path>      Read the value from a file (use this for secrets that should not be visible in chat history).\n' +
  'Exactly one of --value or --from-file must be provided. Interactive prompting is unavailable because Pi\'s TUI captures stdin.';

export function registerSecretSetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-set", {
    description: 'Store a secret in the vault. Usage: /secret-set <NAME> [--note "..."] (--value <secret> | --from-file <path>)',
    handler: async (args: string, ctx) => {
      // Pi's TUI consumes stdin while this handler runs, so a raw
      // readline prompt would race for keystrokes and hang the session
      // (and a Ctrl+C to recover would damage Pi's TUI). Take the value
      // non-interactively via --value or --from-file instead. The .txt
      // file path is the recommended route for secrets the user does
      // not want in shell/chat history.
      const parsed = parseArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error + "\n\n" + USAGE, "error");
        return;
      }
      const { name, note, valueInline, fromFile } = parsed;

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
        ctx.ui.notify("Refusing to store an empty secret value.", "error");
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
        vault.set(name, value, note);
        ctx.ui.notify(`Secret "${name}" stored.`, "info");
      } finally {
        vault.close();
      }
    },
  });
}

type ParsedArgs = {
  name: string;
  note: string | undefined;
  valueInline: string | undefined;
  fromFile: string | undefined;
  error?: string;
};

// Parse "<NAME> [--note \"...\"] [--value <inline>] [--from-file <path>]".
// Tolerates either quoted or unquoted single-token arguments. Returns a
// readable error message rather than throwing.
function parseArgs(raw: string): ParsedArgs {
  const empty: ParsedArgs = { name: "", note: undefined, valueInline: undefined, fromFile: undefined };
  let s = raw;

  // --note "..." — quoted
  let note: string | undefined;
  const noteMatch = s.match(/--note\s+"([^"]+)"/);
  if (noteMatch) {
    note = noteMatch[1];
    s = s.replace(noteMatch[0], "");
  }

  // --value <rest-of-line> — everything after --value is the value (no quoting required)
  let valueInline: string | undefined;
  const valueMatch = s.match(/--value\s+(.+?)(?=\s+--from-file\s|\s*$)/);
  if (valueMatch) {
    valueInline = valueMatch[1].trim();
    s = s.replace(valueMatch[0], "").trim();
  }

  // --from-file <path>
  let fromFile: string | undefined;
  const fileMatch = s.match(/--from-file\s+(\S+)/);
  if (fileMatch) {
    fromFile = fileMatch[1];
    s = s.replace(fileMatch[0], "").trim();
  }

  const name = s.trim();
  if (!name) return { ...empty, error: "Missing required <NAME> argument.", note, valueInline, fromFile };
  if (valueInline !== undefined && fromFile !== undefined) {
    return { ...empty, name, note, valueInline, fromFile, error: "Pass exactly one of --value or --from-file, not both." };
  }
  if (valueInline === undefined && fromFile === undefined) {
    return { ...empty, name, note, valueInline, fromFile, error: "Provide the secret via --value or --from-file." };
  }
  return { name, note, valueInline, fromFile };
}
