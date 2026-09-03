import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_TOKEN_PATTERNS } from "./scrubber.js";
import type { Vault } from "./vault.js";

const LONG_BASE64 = /[A-Za-z0-9+/]{40,}={0,2}/;

export function looksLikeSecret(text: string): boolean {
  for (const re of PROVIDER_TOKEN_PATTERNS) {
    const copy = new RegExp(re.source, re.flags.replaceAll("g", ""));
    copy.lastIndex = 0;
    if (copy.test(text)) return true;
  }
  LONG_BASE64.lastIndex = 0;
  return LONG_BASE64.test(text);
}

export function installInputGuard(pi: Pick<ExtensionAPI, "on">, vault: Vault | null): void {
  pi.on("input", ((event: { text?: unknown }, ctx: { ui?: { notify: (message: string, level?: string) => void } }) => {
    const text = typeof event?.text === "string" ? event.text : "";
    if (!looksLikeSecret(text)) return { action: "continue" as const };
    if (vault === null) {
      ctx.ui?.notify(
        "Detected a likely secret in input but the vault is unavailable. Repair the vault before sending this message.",
        "error",
      );
    } else {
      ctx.ui?.notify(
        "Detected a likely secret in input. Use /factory secret set NAME instead of pasting it into chat.",
        "error",
      );
    }
    return { action: "handled" as const };
  }) as never);
}
