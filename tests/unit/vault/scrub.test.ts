import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeKeyring, MemoryVaultStore, Vault } from "../../../src/vault/index.js";
import { TOKEN_SHAPES, scrubFile, scrubSeed } from "../../../src/vault/scrub.js";

const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("TOKEN_SHAPES", () => {
  it("covers ghp_/github_pat_, sk-, AKIA, xox, JWT, Bearer, hex, PEM", () => {
    expect(TOKEN_SHAPES.length).toBeGreaterThan(0);
    const joined = TOKEN_SHAPES.map((r) => r.source).join(" ");
    expect(joined).toMatch(/ghp_|github_pat_/);
    expect(joined).toMatch(/sk-/);
    expect(joined).toMatch(/AKIA/);
    expect(joined).toMatch(/xox/);
    expect(joined).toMatch(/eyJ/);
    expect(joined).toMatch(/Bearer/);
    expect(joined).toMatch(/BEGIN/);
  });
});

describe("scrubSeed", () => {
  it("replaces a ghp_ token and a vault value with UNBOUND_1/2 in order of appearance", () => {
    const body = `token=${GHP} then s3cret in the script`;
    const result = scrubSeed(body, ["s3cret"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placeholders).toEqual(["secret:UNBOUND_1", "secret:UNBOUND_2"]);
    expect(result.text).toContain("secret:UNBOUND_1");
    expect(result.text).toContain("secret:UNBOUND_2");
    expect(result.text).not.toContain(GHP);
    expect(result.text).not.toContain("s3cret");
  });

  it("is fail-closed when patterns cannot load", () => {
    const result = scrubSeed("anything", [], null);
    expect(result.ok).toBe(false);
  });
});

describe("scrubFile", () => {
  it("rewrites a file in place via tmp+rename and reports hits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-scrub-file-"));
    try {
      const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
      await vault.set("ACME_TOKEN", "s3cret");
      const path = join(dir, "tool.py");
      await writeFile(path, `TOKEN=${GHP}\nVALUE=s3cret\n`, "utf8");
      const out = await scrubFile(path, vault);
      expect(out.hits).toBeGreaterThanOrEqual(2);
      const text = await readFile(path, "utf8");
      expect(text).not.toContain(GHP);
      expect(text).not.toContain("s3cret");
      expect(text).toContain("secret:UNBOUND_");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
