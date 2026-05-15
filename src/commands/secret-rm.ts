import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadVaultForCommand } from "./secret-shared.js";

export function registerSecretRmCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-rm", {
    description: "Delete a secret from the vault. Usage: /secret-rm <NAME> --yes",
    handler: async (args: string, ctx) => {
      // Pi's TUI consumes stdin so an interactive y/N prompt would hang
      // the session. Require an explicit --yes flag instead so the
      // delete is intentional but never blocks on a missing keystroke.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const yesIdx = tokens.indexOf("--yes");
      const confirmed = yesIdx !== -1;
      if (confirmed) tokens.splice(yesIdx, 1);
      const name = tokens.join(" ").trim();
      if (!name) {
        ctx.ui.notify("Usage: /secret-rm <NAME> --yes", "error");
        return;
      }
      if (!confirmed) {
        ctx.ui.notify(
          `Refusing to delete "${name}" without --yes. Run: /secret-rm ${name} --yes`,
          "error",
        );
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
