import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGlobalConfig, writeRepoConfig } from "../../../src/setup/writers.js";
import { migrateConfig } from "../../../src/config/migrate.js";

let home: string;
let repo: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-sdlc-wglobal-"));
  repo = await mkdtemp(join(tmpdir(), "pi-sdlc-wrepo-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("writeGlobalConfig", () => {
  it("stamps schemaVersion and writes a FactoryConfig-shaped overlay", async () => {
    const path = await writeGlobalConfig(home, {
      operator: { coAuthoredBy: true, maxLanes: 1, maxLanesPerRepo: 1 },
      defaults: { sandbox: "off", steering: "never", planApproval: "never" },
      repos: [{ path: repo, remote: "origin", tracker: "local", project: "fixture", label: "factory:ready" }],
    });
    expect(path).toBe(join(home, "factory.json"));
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
    expect(raw).not.toHaveProperty("answers");
    expect((raw.operator as { sandbox?: unknown } | undefined)?.sandbox).toBeUndefined();
    expect((raw.defaults as { sandbox: string }).sandbox).toBe("off");
    expect((raw.defaults as { setupCommand?: unknown }).setupCommand).toBeUndefined();
    expect(() => migrateConfig(raw)).not.toThrow();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects an overlay that puts sandbox on operator (schema additionalProperties: false)", async () => {
    await expect(
      writeGlobalConfig(home, { operator: { sandbox: "off" } as never }),
    ).rejects.toThrow(/unknown key/i);
  });
});

describe("writeRepoConfig", () => {
  it("writes the local overlay when { local: true }", async () => {
    const path = await writeRepoConfig(repo, { defaults: { steering: "never" } }, { local: true });
    expect(path).toBe(join(repo, ".pi", "factory.local.json"));
    const raw = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; steering: string };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.steering).toBe("never");
  });
});
