import type { Vault } from "./Vault.js";

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
