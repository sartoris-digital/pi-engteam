import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadVaultForCommand, confirmAction } from "./secret-shared.js";

export function registerSecretRmCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-rm", {
    description: "Delete a secret from the vault. Usage: /secret-rm <NAME>",
    handler: async (args: string, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /secret-rm <NAME>", "error");
        return;
      }

      const ok = await confirmAction(`Delete secret "${name}"?`);
      if (!ok) {
        ctx.ui.notify("Aborted.", "info");
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
        const removed = vault.remove(name);
        ctx.ui.notify(
          removed ? `Secret "${name}" deleted.` : `Secret "${name}" not found.`,
          removed ? "info" : "error",
        );
      } finally {
        vault.close();
      }
    },
  });
}
