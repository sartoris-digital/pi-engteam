import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { runSecret } from "../../../src/commands/secret.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { FakeKeyring, MemoryVaultStore, Vault } from "../../../src/vault/index.js";

function depsWith(vault: Vault): FactoryDeps {
  return {
    home: "/h",
    runsDir: "/h/runs",
    projectRootDefault: "/pkg",
    engine: {},
    executor: {},
    provider: {},
    tracker: {},
    agents: [],
    lanes: {},
    piBinary: "pi",
    repos: [],
    vault,
  } as unknown as FactoryDeps;
}

describe("runSecret", () => {
  it("sets via --from-file, lists metadata without plaintext, rms and rotates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-secret-"));
    try {
      const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
      const deps = depsWith(vault);
      const file = join(dir, "token");
      await writeFile(file, "super-secret-value", { mode: 0o600 });

      const setOut = await runSecret(parseFactoryArgs(`secret set ACME_TOKEN --from-file ${file}`), deps);
      expect(setOut).toMatch(/ACME_TOKEN/);
      expect(setOut).not.toContain("super-secret-value");

      const listed = await runSecret(parseFactoryArgs("secret list"), deps);
      expect(listed).toContain("ACME_TOKEN");
      expect(listed).not.toContain("super-secret-value");
      expect(JSON.stringify(await vault.list())).not.toContain("super-secret-value");
      expect(await vault.getPlaintext("ACME_TOKEN")).toBe("super-secret-value");

      const rotFile = join(dir, "token2");
      await writeFile(rotFile, "rotated-secret-value", { mode: 0o600 });
      const rotated = await runSecret(parseFactoryArgs(`secret rotate ACME_TOKEN --from-file ${rotFile}`), deps);
      expect(rotated).toMatch(/ACME_TOKEN/);
      expect(rotated).not.toContain("rotated-secret-value");
      expect(await vault.getPlaintext("ACME_TOKEN")).toBe("rotated-secret-value");

      await expect(runSecret(parseFactoryArgs("secret rm ACME_TOKEN"), deps)).rejects.toThrow(/yes/);
      await runSecret(parseFactoryArgs("secret rm ACME_TOKEN --yes"), deps);
      expect(await vault.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("binds an unbound placeholder, exports/imports without plaintext, and scrubs a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-secret-v15-"));
    try {
      const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
      const deps = depsWith(vault);
      await vault.set("AEM_STAGING_TOKEN", "tok-staging");
      const seedPath = join(dir, "run-1-implement-0.json");
      await writeFile(
        seedPath,
        `${JSON.stringify({
          runId: "run-1",
          stage: "implement",
          n: 0,
          trigger: "script-seed",
          scriptPath: "scripts/sync_aem.py",
          commandLines: [],
          filesRead: [],
          envNames: [],
          effect: {},
          taskContextFenced: "```\n```",
          placeholders: ["secret:UNBOUND_1"],
        })}\n`,
        "utf8",
      );

      const bound = await runSecret(
        parseFactoryArgs(`secret bind secret:UNBOUND_1 --to secret:AEM_STAGING_TOKEN --seed ${seedPath}`),
        deps,
      );
      expect(bound).toMatch(/AEM_STAGING_TOKEN/);
      expect(bound).not.toContain("tok-staging");

      const exportPath = join(dir, "vault.json");
      const passphraseFile = join(dir, "pass");
      await writeFile(passphraseFile, "export-passphrase", { mode: 0o600 });
      const exported = await runSecret(
        parseFactoryArgs(`secret export ${exportPath} --passphrase-from-file ${passphraseFile}`),
        deps,
      );
      expect(exported).toMatch(/export/);
      const envelope = JSON.parse(await readFile(exportPath, "utf8")) as Record<string, unknown>;
      expect(JSON.stringify(envelope)).not.toContain("tok-staging");
      expect(envelope.schemaVersion).toBe(1);

      const dest = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
      const imported = await runSecret(
        parseFactoryArgs(`secret import ${exportPath} --passphrase-from-file ${passphraseFile}`),
        depsWith(dest),
      );
      expect(imported).toMatch(/AEM_STAGING_TOKEN/);
      expect(await dest.getPlaintext("AEM_STAGING_TOKEN")).toBe("tok-staging");

      const leak = join(dir, "tool.py");
      await writeFile(leak, "tok-staging and ghp_abcdefghijklmnopqrstuvwxyz0123456789\n", "utf8");
      const scrubbed = await runSecret(parseFactoryArgs(`secret scrub ${leak}`), deps);
      expect(scrubbed).toMatch(/hit/i);
      const text = await readFile(leak, "utf8");
      expect(text).not.toContain("tok-staging");
      expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
