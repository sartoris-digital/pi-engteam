import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { promptPassphrase } from "../secrets/Passphrase.js";
import { loadVaultForCommand } from "./secret-shared.js";

export function registerSecretRotateCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-rotate", {
    description: "Replace the value of an existing secret. Usage: /secret-rotate <NAME>",
    handler: async (args: string, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /secret-rotate <NAME>", "error");
        return;
      }

      let value: string;
      try {
        value = await promptPassphrase({ prompt: `New value for ${name}: `, confirm: false });
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
        // Preserve existing notes when rotating.
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
