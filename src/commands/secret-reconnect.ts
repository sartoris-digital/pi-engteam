import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { buildMasterKeyManager, VAULT_DB_PATH } from "./secret-shared.js";
import {
  createKeyringBackend,
  diagnoseKeyring,
  decideReconnectMode,
  KEYRING_SERVICE,
  KEYRING_ACCOUNT_MASTER,
} from "../secrets/Keyring.js";
import { isTtyAvailable } from "../secrets/Passphrase.js";

export function registerSecretReconnectCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-reconnect", {
    description: "Diagnose why the vault can't open and reconnect it to the OS keychain.",
    handler: async (_args: string, ctx) => {
      const diag = diagnoseKeyring();
      const backend = createKeyringBackend();
      const keychainHasKey =
        backend?.get(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER).kind === "value";
      const mode = decideReconnectMode(diag, keychainHasKey);

      if (mode === "mode1") {
        ctx.ui.notify(
          `Keyring native addon failed to load (${diag.detail ?? "unknown"}). The Keychain key is intact — rebuild the addon:\n` +
          `  nvm use 22 && pnpm rebuild && pnpm run engineering:install`,
          "error",
        );
        return;
      }
      if (mode === "locked") {
        ctx.ui.notify("OS keychain is locked or denied access. Unlock your login keychain and retry.", "error");
        return;
      }
      if (mode === "healthy") {
        ctx.ui.notify("Vault is already connected to the keychain — nothing to do.", "info");
        return;
      }

      // mode === "mode2": keychain entry is gone. Recover via the passphrase backup.
      if (!existsSync(VAULT_DB_PATH)) {
        ctx.ui.notify("No vault file found — nothing to reconnect.", "info");
        return;
      }
      if (!isTtyAvailable()) {
        ctx.ui.notify("Reconnect needs an interactive terminal for the recovery passphrase.", "error");
        return;
      }

      const manager = buildMasterKeyManager();
      let masterKey: Buffer;
      try {
        masterKey = await manager.ensureInitialized(); // prompts for recovery passphrase, unwraps the blob
      } catch (err) {
        ctx.ui.notify(`Reconnect failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        manager.zeroize();
        return;
      }

      if (!backend) {
        ctx.ui.notify("Vault unlocked for this session, but the keyring addon isn't available, so the key can't be persisted. Rebuild it (see /engineering-doctor), then re-run /secret-reconnect.", "warning");
        manager.zeroize();
        return;
      }
      try {
        backend.set(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER, masterKey.toString("hex"));
        ctx.ui.notify("Reconnected — master key restored to the OS keychain. Future sessions won't prompt for the passphrase.", "info");
      } catch (err) {
        ctx.ui.notify(`Recovered for this session, but writing to the keychain failed (${err instanceof Error ? err.message : String(err)}). Unlock the keychain and retry.`, "warning");
      } finally {
        manager.zeroize();
      }
    },
  });
}
