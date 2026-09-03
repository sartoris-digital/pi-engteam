import type { KeyringPort } from "./types.js";

export class FakeKeyring implements KeyringPort {
  private readonly entries = new Map<string, string>();

  async get(service: string, account: string): Promise<string | null> {
    return this.entries.get(`${service}\0${account}`) ?? null;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    this.entries.set(`${service}\0${account}`, secret);
  }

  async delete(service: string, account: string): Promise<void> {
    this.entries.delete(`${service}\0${account}`);
  }
}
