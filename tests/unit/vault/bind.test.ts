import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeKeyring, MemoryVaultStore, Vault } from "../../../src/vault/index.js";
import { bindSecret, secretsBound } from "../../../src/vault/bind.js";
import type { SeedRecord } from "../../../src/codify/seeds.js";

function seed(over: Partial<SeedRecord> = {}): SeedRecord {
  return {
    runId: "run-1",
    stage: "implement",
    n: 0,
    trigger: "script-seed",
    scriptPath: "scripts/sync_aem.py",
    commandLines: [{ argv: ["python", "scripts/sync_aem.py"], exitCode: 0 }],
    filesRead: [],
    envNames: ["TOKEN"],
    effect: {},
    taskContextFenced: "```\n```",
    placeholders: ["secret:UNBOUND_1", "secret:UNBOUND_2"],
    ...over,
  };
}

describe("bindSecret", () => {
  it("binds UNBOUND_1 to an existing vault name and updates the seed + pending manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-bind-"));
    try {
      const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
      await vault.set("AEM_STAGING_TOKEN", "tok-staging");
      const seedPath = join(dir, "run-1-implement-0.json");
      await mkdir(dir, { recursive: true });
      await writeFile(seedPath, `${JSON.stringify(seed(), null, 2)}\n`, "utf8");

      const result = await bindSecret({
        seedPath,
        placeholder: "secret:UNBOUND_1",
        to: "secret:AEM_STAGING_TOKEN",
        vault,
      });
      expect(result.bindings["secret:UNBOUND_1"]).toBe("secret:AEM_STAGING_TOKEN");
      expect(result.secretsBound).toBe(false);

      const onDisk = JSON.parse(await readFile(seedPath, "utf8")) as SeedRecord;
      expect(onDisk.bindings?.["secret:UNBOUND_1"]).toBe("secret:AEM_STAGING_TOKEN");
      expect(onDisk.secretsBound).toBe(false);

      const manifest = JSON.parse(await readFile(join(dir, "run-1-implement-0.manifest.json"), "utf8")) as {
        secrets: string[];
        secretsBound: boolean;
      };
      expect(manifest.secrets).toContain("secret:AEM_STAGING_TOKEN");
      expect(manifest.secretsBound).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("secretsBound is true only when every placeholder is bound", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-bind-all-"));
    try {
      const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
      await vault.set("AEM_STAGING_TOKEN", "a");
      await vault.set("AEM_DEV_TOKEN", "b");
      const seedPath = join(dir, "s.json");
      await writeFile(seedPath, `${JSON.stringify(seed(), null, 2)}\n`, "utf8");
      await bindSecret({ seedPath, placeholder: "secret:UNBOUND_1", to: "secret:AEM_STAGING_TOKEN", vault });
      const second = await bindSecret({ seedPath, placeholder: "secret:UNBOUND_2", to: "secret:AEM_DEV_TOKEN", vault });
      expect(second.secretsBound).toBe(true);
      expect(secretsBound(JSON.parse(await readFile(seedPath, "utf8")) as SeedRecord)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("--set writes the value then binds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-bind-set-"));
    try {
      const vault = new Vault({ store: new MemoryVaultStore(), keyring: new FakeKeyring() });
      const seedPath = join(dir, "s.json");
      await writeFile(seedPath, `${JSON.stringify(seed({ placeholders: ["secret:UNBOUND_1"] }), null, 2)}\n`, "utf8");
      const result = await bindSecret({
        seedPath,
        placeholder: "secret:UNBOUND_1",
        set: { name: "secret:AEM_STAGING_TOKEN", value: "fresh-token" },
        vault,
      });
      expect(await vault.getPlaintext("AEM_STAGING_TOKEN")).toBe("fresh-token");
      expect(result.bindings["secret:UNBOUND_1"]).toBe("secret:AEM_STAGING_TOKEN");
      expect(result.secretsBound).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
