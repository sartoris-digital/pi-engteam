import type { Vault } from "./Vault.js";

// Env-var-style grammar: starts with uppercase letter, then uppercase letters,
// digits, or underscores. Max 128 chars. Forbids surrounding whitespace, quotes,
// shell metacharacters, prompt-injection markers — anything that could surprise
// the agent or a downstream subprocess if echoed back in an error.
const VALID_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export function isValidSecretName(name: unknown): name is string {
  return typeof name === "string" && VALID_NAME.test(name);
}

export interface SecretResolver {
  resolve(name: string, opts: { agent: string; target: string }): string;
  listNames(): string[];
}

export function createSecretResolver(opts: {
  vault: Vault;
  emitEvent: (evt: { category: "safety"; type: "secret_access"; payload: Record<string, unknown> }) => void;
}): SecretResolver {
  const { vault, emitEvent } = opts;
  return {
    resolve(name, { agent, target }) {
      // Validate strictly BEFORE any echo. An invalid name must not appear in the
      // error message verbatim — that's the prompt-injection vector.
      if (!isValidSecretName(name)) {
        throw new Error(
          "Secret name is invalid. Names must match [A-Z][A-Z0-9_]{0,127}. Use only uppercase letters, digits, and underscores; start with a letter; max 128 chars.",
        );
      }
      const value = vault.get(name);
      if (value === null) {
        throw new Error(`Secret not found: ${name}`);
      }
      emitEvent({
        category: "safety",
        type: "secret_access",
        payload: {
          secret_name: name,
          agent,
          target,
          timestamp: new Date().toISOString(),
        },
      });
      return value;
    },
    listNames() {
      return vault.list().map((r) => r.name);
    },
  };
}
