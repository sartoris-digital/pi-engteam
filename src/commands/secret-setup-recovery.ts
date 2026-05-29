import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildMasterKeyManager, hasMaskedPrompt, promptMaskedPassphrase } from "./secret-shared.js";

export function registerSecretSetupRecoveryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-setup-recovery", {
    description: "Enroll a recovery passphrase so the vault can be recovered if the OS keychain is lost.",
    handler: async (_args: string, ctx) => {
      if (!hasMaskedPrompt(ctx)) {
        ctx.ui.notify("Recovery enrollment needs an interactive Pi session (masked prompt unavailable here).", "error");
        return;
      }
      const manager = buildMasterKeyManager();
      try {
        await manager.ensureInitialized(); // unlock via keychain (no prompt when keychain-connected)
      } catch (err) {
        ctx.ui.notify(`Vault unavailable: ${err instanceof Error ? err.message : String(err)}`, "error");
        manager.zeroize();
        return;
      }
      ctx.ui.notify(
        "Choose a recovery passphrase. Anyone with both the secrets.db file AND this passphrase can decrypt your secrets — pick a strong one.",
        "info",
      );
      try {
        const first = await promptMaskedPassphrase(ctx, "New recovery passphrase:");
        if (first.cancelled) { ctx.ui.notify("Recovery enrollment cancelled.", "info"); return; }
        if (!first.value) { ctx.ui.notify("Recovery passphrase must not be empty.", "error"); return; }
        const confirm = await promptMaskedPassphrase(ctx, "Confirm recovery passphrase:");
        if (confirm.cancelled) { ctx.ui.notify("Recovery enrollment cancelled.", "info"); return; }
        if (confirm.value !== first.value) { ctx.ui.notify("Passphrases do not match.", "error"); return; }
        await manager.enrollRecovery(first.value);
        ctx.ui.notify("Recovery passphrase enrolled. You can now run /secret-reconnect to recover on a new machine or after a keychain reset.", "info");
      } catch (err) {
        ctx.ui.notify(`Enrollment failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        manager.zeroize();
      }
    },
  });
}
