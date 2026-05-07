import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { promptPassphrase } from "../secrets/Passphrase.js";
import { loadVaultForCommand } from "./secret-shared.js";

export function registerSecretSetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-set", {
    description: "Store a secret in the vault. Usage: /secret-set <NAME> [--note \"...\"]",
    handler: async (args: string, ctx) => {
      const noteMatch = args.match(/--note\s+"([^"]+)"/);
      const note = noteMatch ? noteMatch[1] : undefined;
      const name = args.replace(/--note\s+"[^"]*"/, "").trim();

      if (!name) {
        ctx.ui.notify('Usage: /secret-set <NAME> [--note "..."]', "error");
        return;
      }

      let value: string;
      try {
        value = await promptPassphrase({ prompt: `Value for ${name}: `, confirm: false });
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
        vault.set(name, value, note);
        ctx.ui.notify(`Secret "${name}" stored.`, "info");
      } finally {
        vault.close();
      }
    },
  });
}
