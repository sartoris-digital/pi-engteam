// src/secrets/Integration.ts
//
// Wires the secret Watcher into Pi's user-input hook so accidentally-pasted
// secrets are intercepted BEFORE the message reaches any agent's context.
//
// Composes alongside other input handlers (e.g. the approval/answering handler
// in src/index.ts) — a "continue" result lets subsequent handlers run.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Vault } from "./Vault.js";
import { type SecretMatch, scan } from "./Watcher.js";
import { type SecretPattern, loadPatterns as defaultLoadPatterns } from "./patterns.js";

export type IntegrationConfig = {
  enabled: boolean;
  interactivePrompt: boolean;     // false = silent auto-vault with suggested name; true = prompt user
  onSkipBehavior: "warn" | "block";
  entropyEnabled: boolean;
  vault: Vault;
  emitEvent: (evt: {
    category: "safety";
    type: "secret_skip" | "secret_access";
    payload: Record<string, unknown>;
  }) => void;
  loadPatterns: () => SecretPattern[];
};

export type IntegrationDecision =
  | { action: "pass-through"; rewritten: string }
  | { action: "vault-and-rewrite"; rewritten: string; vaulted: Array<{ name: string; original: string }> }
  | { action: "user-skipped" }
  | { action: "user-aborted" };

export type PromptDecision =
  | { choice: "vault"; vaultName: string }
  | { choice: "skip" }
  | { choice: "abort" };

export type PromptFn = (match: SecretMatch) => Promise<PromptDecision>;

/**
 * Pure function. Scans input. For each match (in priority order), invokes the
 * prompt callback and applies the user's decision. Vault overwrites: if the
 * chosen name already exists, we always overwrite — the user is in the prompt
 * loop, they typed the name, they own it.
 */
export async function processInput(
  input: string,
  config: IntegrationConfig,
  prompt: PromptFn,
): Promise<IntegrationDecision> {
  const entropy = config.entropyEnabled
    ? { enabled: true, minLength: 32, minBitsPerChar: 4.5 }
    : undefined;

  let current = input;
  const vaulted: Array<{ name: string; original: string }> = [];
  let anySkipped = false;

  // Re-scan after each vault rewrite because offsets shift; loop until either
  // no matches remain or every remaining match has been skipped.
  const skippedSpans = new Set<string>();
  while (true) {
    const matches = scan(current, {
      patterns: config.loadPatterns(),
      entropy,
    });
    const next = matches.find((m) => !skippedSpans.has(spanKey(m)));
    if (!next) break;

    const decision = await prompt(next);
    if (decision.choice === "abort") {
      return { action: "user-aborted" };
    }
    if (decision.choice === "skip") {
      anySkipped = true;
      skippedSpans.add(spanKey(next));
      config.emitEvent({
        category: "safety",
        type: "secret_skip",
        payload: {
          patternName: next.pattern.name,
          suggestedName: next.pattern.suggestedName,
          preview: next.preview,
        },
      });
      continue;
    }
    // choice === "vault"
    const vaultName = decision.vaultName;
    config.vault.set(vaultName, next.value, "auto-vaulted via watcher");
    vaulted.push({ name: vaultName, original: next.value });
    current =
      current.slice(0, next.start) +
      `\${SECRET:${vaultName}}` +
      current.slice(next.end);
    // Reset skip set: offsets shifted, previous skipped spans are stale.
    skippedSpans.clear();
  }

  if (vaulted.length > 0) {
    return { action: "vault-and-rewrite", rewritten: current, vaulted };
  }
  if (anySkipped) {
    // Skipped values were left in place; treat as pass-through with the
    // original input (skip emits already fired).
    return { action: "pass-through", rewritten: input };
  }
  return { action: "pass-through", rewritten: current };
}

function spanKey(m: SecretMatch): string {
  return `${m.start}:${m.end}:${m.pattern.name}`;
}

/**
 * Registers a pi.on("input", ...) handler. Runs alongside other input handlers
 * — both register independently and the first to return action="handled" wins.
 */
export function registerWatcher(pi: ExtensionAPI, config: IntegrationConfig): void {
  pi.on("input", async (event, ctx) => {
    if (!config.enabled) return { action: "continue" as const };

    const loadPatterns = config.loadPatterns ?? defaultLoadPatterns;
    const cfg: IntegrationConfig = { ...config, loadPatterns };

    // v1: Pi's ctx.ui exposes no blocking multi-choice prompt to extensions, so
    // both interactivePrompt modes auto-vault under the pattern's suggested
    // name. interactivePrompt=true emits a post-hoc notify; the "real" prompt
    // path returns when Pi adds a chooser API.
    //
    // Codex round-3 MEDIUM: a thrown loadPatterns() (malformed JSON in
    // secret-patterns.json, broken module export, etc.) previously
    // propagated up to Pi as an unhandled rejection — and Pi continued
    // forwarding the user message as if no watcher had run, fail-open.
    // Fail closed here: any error inside processInput blocks the message
    // and surfaces a repair hint.
    let decision: Awaited<ReturnType<typeof processInput>>;
    try {
      decision = await processInput(event.text, cfg, async (match) => {
        return { choice: "vault", vaultName: match.pattern.suggestedName };
      });
    } catch (err) {
      ctx.ui.notify(
        `Secret-watcher error (input refused for safety): ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return { action: "handled" as const };
    }

    if (decision.action === "pass-through") {
      return { action: "continue" as const };
    }
    if (decision.action === "user-aborted") {
      ctx.ui.notify("Message cancelled.", "info");
      return { action: "handled" as const };
    }
    if (decision.action === "user-skipped") {
      // Skips already emitted via emitEvent inside processInput.
      if (cfg.onSkipBehavior === "block") {
        ctx.ui.notify("Message blocked: secret left in plaintext.", "error");
        return { action: "handled" as const };
      }
      ctx.ui.notify("Warning: secret left in message.", "warning");
      return { action: "continue" as const };
    }
    // vault-and-rewrite: transform the input text in place.
    if (cfg.interactivePrompt) {
      const names = decision.vaulted.map((v) => v.name).join(", ");
      ctx.ui.notify(
        `Auto-vaulted secret(s) as ${names}; message rewritten with \${SECRET:...} placeholders.`,
        "info",
      );
    }
    return {
      action: "transform" as const,
      text: decision.rewritten,
      images: event.images,
    };
  });
}
