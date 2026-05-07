import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadVaultForCommand, formatSecretRow } from "./secret-shared.js";

export function registerSecretListCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-list", {
    description: "List all secrets in the vault (names and metadata only — never values).",
    handler: async (_args: string, ctx) => {
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
        if (rows.length === 0) {
          ctx.ui.notify("No secrets stored.", "info");
          return;
        }
        const lines = [
          `${"NAME".padEnd(32)} CREATED     LAST_USED   USES  NOTES`,
          ...rows.map(formatSecretRow),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } finally {
        vault.close();
      }
    },
  });
}
