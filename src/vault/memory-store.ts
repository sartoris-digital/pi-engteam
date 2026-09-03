import type { SecretMeta, VaultRecord, VaultStore } from "./types.js";

export class MemoryVaultStore implements VaultStore {
  private readonly records = new Map<string, VaultRecord>();

  put(rec: VaultRecord): void {
    this.records.set(rec.meta.name, {
      meta: { ...rec.meta, ...(rec.meta.scopes ? { scopes: [...rec.meta.scopes] } : {}) },
      nonce: rec.nonce,
      ciphertext: rec.ciphertext,
      salt: rec.salt,
    });
  }

  get(name: string): VaultRecord | undefined {
    const rec = this.records.get(name);
    if (rec === undefined) return undefined;
    return {
      meta: { ...rec.meta, ...(rec.meta.scopes ? { scopes: [...rec.meta.scopes] } : {}) },
      nonce: rec.nonce,
      ciphertext: rec.ciphertext,
      salt: rec.salt,
    };
  }

  delete(name: string): boolean {
    return this.records.delete(name);
  }

  list(): SecretMeta[] {
    return [...this.records.values()].map((rec) => ({
      ...rec.meta,
      ...(rec.meta.scopes ? { scopes: [...rec.meta.scopes] } : {}),
    }));
  }
}
