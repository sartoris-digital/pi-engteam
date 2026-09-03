import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type DoctorReport } from "../../../src/commands/doctor.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { LocalAdapter } from "../../../src/trackers/local.js";
import type { TrackerAdapter } from "../../../src/trackers/adapter.js";
import { VaultUnavailableError } from "../../../src/vault/vault.js";
import { writeGlobalConfig } from "../../../src/setup/writers.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

function failingGithub(): TrackerAdapter {
  return {
    id: "github",
    capabilities: new Set(),
    detect: async () => ({ available: false, reason: "gh auth failed" }),
  } as TrackerAdapter;
}

describe("runDoctor", () => {
  it("fails the adapters probe when detect returns unavailable", async () => {
    await withTmpHome(async (home) => {
      const runs = join(home, "runs");
      await mkdir(join(runs, "_factory"), { recursive: true });
      const adapters = new Map<string, TrackerAdapter>([
        ["local", new LocalAdapter(runs)],
        ["github", failingGithub()],
      ]);
      const deps = {
        home,
        runsDir: runs,
        projectRootDefault: "/pkg",
        engine: {},
        executor: {},
        provider: {},
        tracker: new LocalAdapter(runs),
        adapters,
        agents: [],
        lanes: {},
        piBinary: "pi",
        repos: [],
      } as unknown as FactoryDeps;
      const report: DoctorReport = (await runDoctor(deps, { structured: true })) as DoctorReport;
      const adaptersProbe = report.probes.find((p) => p.name === "adapters");
      expect(adaptersProbe?.status).toBe("fail");
      expect(adaptersProbe?.detail).toMatch(/gh auth failed/);
      expect(adaptersProbe?.fix).toMatch(/gh auth/i);
      expect(report.metrics.abstentionRate).toBe(0);
      expect(report.metrics.landedAs).toEqual({ clean: 0, "human-modified": 0, partial: 0, closed: 0 });
    });
  });

  it("fails the vault probe on VaultUnavailableError and names secret-using lanes", async () => {
    await withTmpHome(async (home) => {
      await writeGlobalConfig(home, {
        operator: { github: { appToken: "secret:MISSING_TOKEN" } },
      });
      const runs = join(home, "runs");
      await mkdir(join(runs, "_factory"), { recursive: true });
      const deps = {
        home,
        runsDir: runs,
        projectRootDefault: "/pkg",
        engine: {},
        executor: {},
        provider: {},
        tracker: new LocalAdapter(runs),
        adapters: new Map([["local", new LocalAdapter(runs)]]),
        agents: [],
        lanes: { chore: { class: "build", match: { kind: "chore" }, priority: 100, budget: { fixRounds: 1, maxWallSeconds: 1, maxCostUsd: 1 }, stages: [] } },
        piBinary: "pi",
        repos: [],
      } as unknown as FactoryDeps;
      const report = (await runDoctor(deps, {
        structured: true,
        openVault: async () => {
          throw new VaultUnavailableError("keyring locked");
        },
      })) as DoctorReport;
      const vault = report.probes.find((p) => p.name === "vault");
      expect(vault?.status).toBe("fail");
      expect(vault?.detail).toMatch(/keyring locked|unavailable|MISSING_TOKEN/);
      expect(vault?.fix).toMatch(/secret set|vault/i);
    });
  });

  it("does not touch the network", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-doctor-net-"));
    try {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("network");
      }) as typeof fetch;
      try {
        const text = await runDoctor({
          home: tmp,
          runsDir: join(tmp, "runs"),
          projectRootDefault: tmp,
          engine: {},
          executor: {},
          provider: {},
          tracker: new LocalAdapter(join(tmp, "runs")),
          agents: [],
          lanes: {},
          piBinary: "pi",
          repos: [],
        } as unknown as FactoryDeps);
        expect(typeof text).toBe("string");
        expect(text).toMatch(/adapters|vault|sandbox/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
