import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildMasterKeyManager } from "./secret-shared.js";
import { promptPassphrase, isTtyAvailable } from "../secrets/Passphrase.js";

export function registerSecretSetupRecoveryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-setup-recovery", {
    description: "Enroll a recovery passphrase so the vault can be recovered if the OS keychain is lost.",
    handler: async (_args: string, ctx) => {
      if (!isTtyAvailable()) {
        ctx.ui.notify("Recovery enrollment needs an interactive terminal. Run /secret-setup-recovery in a Pi controller session.", "error");
        return;
      }
      const manager = buildMasterKeyManager();
      try {
        await manager.ensureInitialized(); // unlock the vault (keychain or existing recovery/passphrase)
      } catch (err) {
        ctx.ui.notify(`Vault unavailable: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      ctx.ui.notify(
        "Choose a recovery passphrase. Anyone with both the secrets.db file AND this passphrase can decrypt your secrets — pick a strong one.",
        "info",
      );
      try {
        const passphrase = await promptPassphrase({ prompt: "New recovery passphrase: ", confirm: true });
        if (!passphrase) {
          ctx.ui.notify("Recovery passphrase must not be empty.", "error");
          return;
        }
        await manager.enrollRecovery(passphrase);
        ctx.ui.notify("Recovery passphrase enrolled. You can now run /secret-reconnect to recover on a new machine or after a keychain reset.", "info");
      } catch (err) {
        ctx.ui.notify(`Enrollment failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        manager.zeroize();
      }
    },
  });
}
