import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("refuses export/import/scrub/bind", async () => {
    const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
    const deps = depsWith(vault);
    for (const verb of ["export", "import", "scrub", "bind"]) {
      await expect(runSecret(parseFactoryArgs(`secret ${verb}`), deps)).rejects.toThrow(/not in v1|unknown/i);
    }
  });
});
