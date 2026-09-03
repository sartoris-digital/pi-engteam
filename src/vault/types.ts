export interface SecretMeta {
  name: string;
  note?: string;
  createdAt: string;
  rotatedAt?: string;
  scopes?: string[];
}

/** Encrypted row. nonce/ciphertext/salt are hex; never plaintext. */
export interface VaultRecord {
  meta: SecretMeta;
  nonce: string;
  ciphertext: string;
  salt: string;
}

export interface VaultStore {
  put(rec: VaultRecord): void;
  get(name: string): VaultRecord | undefined;
  delete(name: string): boolean;
  list(): SecretMeta[];
}

export interface KeyringPort {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}
