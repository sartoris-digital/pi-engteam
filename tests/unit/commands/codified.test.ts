import { describe, expect, it } from "vitest";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { runCodified, type CodifiedCommandContext } from "../../../src/commands/codified.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { readCodifiedLedger } from "../../../src/codify/ledger.js";
import {
  emptyRegistry,
  loadRegistry,
  saveRegistry,
  type Registry,
  type RegistryEntry,
} from "../../../src/codify/registry.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

function sha(label: string): string {
  return label.padEnd(64, "0").slice(0, 64);
}

function entry(over: Partial<RegistryEntry> & Pick<RegistryEntry, "name">): RegistryEntry {
  return {
    version: 1,
    class: "stage-tool",
    scope: "repo",
    repo: "acme/app",
    state: "staged",
    toolSha256: sha("tool"),
    manifestSha256: sha("man"),
    skillSha256: sha("skl"),
    judgedSha: sha("jdg"),
    validation: { baseSha: sha("base") },
    secretsBound: true,
    landedAs: "clean",
    matcher: {
      titlePatterns: ["chore: bump .+"],
      planStepPatterns: ["bump .+ version"],
      pathGlobs: ["package.json"],
    },
    writeGlobs: ["package.json"],
    readGlobs: ["package.json"],
    stats: {
      exact: 0,
      partial: 0,
      shadowAgree: 0,
      shadowDisagree: 0,
      preconditionRefusals: 0,
      failures: 0,
      recentHits: [],
      savedUsd: 12.5,
      savedWallSeconds: 40,
    },
    history: [],
    ...over,
  };
}

function registryOf(...entries: RegistryEntry[]): Registry {
  const reg = emptyRegistry();
  for (const e of entries) reg.entries[e.name] = e;
  return reg;
}

function depsFor(home: string): FactoryDeps {
  return {
    home,
    runsDir: `${home}/runs`,
    projectRootDefault: "/pkg",
    engine: {},
    executor: {},
    provider: {},
    tracker: {},
    agents: [],
    lanes: {},
    piBinary: "pi",
    repos: [],
  } as unknown as FactoryDeps;
}

function ui(over: Partial<CodifiedCommandContext> = {}): CodifiedCommandContext {
  return {
    hasUI: true,
    ui: { confirm: async () => true },
    ...over,
  };
}

describe("parseFactoryArgs codified", () => {
  it("parses list, explain, why, promote, demote, retire, retry, shadow, diff", () => {
    expect(parseFactoryArgs("codified list").verb).toBe("codified");
    expect(parseFactoryArgs("codified list").args).toEqual(["list"]);
    expect(parseFactoryArgs("codified explain bump-package-version").args).toEqual([
      "explain",
      "bump-package-version",
    ]);
    expect(parseFactoryArgs("codified why chore: bump pkg to 1.3.0").args).toEqual([
      "why",
      "chore:",
      "bump",
      "pkg",
      "to",
      "1.3.0",
    ]);
    expect(parseFactoryArgs("codified promote bump-package-version@1").args).toEqual([
      "promote",
      "bump-package-version@1",
    ]);
    expect(parseFactoryArgs("codified demote bump-package-version").args[0]).toBe("demote");
    expect(parseFactoryArgs("codified retire bump-package-version").args[0]).toBe("retire");
    expect(parseFactoryArgs("codified retry bump-package-version").args[0]).toBe("retry");
    expect(parseFactoryArgs("codified shadow bump-package-version").args[0]).toBe("shadow");
    expect(parseFactoryArgs("codified diff bump-package-version").args[0]).toBe("diff");
  });
});

describe("runCodified", () => {
  it("list prints state, version, and savedUsd", async () => {
    await withTmpHome(async (home) => {
      await saveRegistry(home, registryOf(entry({ name: "bump-package-version" })));
      const out = await runCodified(parseFactoryArgs("codified list"), depsFor(home), ui());
      expect(out).toContain("bump-package-version");
      expect(out).toMatch(/\bv1\b/);
      expect(out).toContain("staged");
      expect(out).toMatch(/12\.5/);
    });
  });

  it("promote without UI throws", async () => {
    await withTmpHome(async (home) => {
      await saveRegistry(home, registryOf(entry({ name: "bump-package-version" })));
      await expect(
        runCodified(parseFactoryArgs("codified promote bump-package-version@1"), depsFor(home), {
          hasUI: false,
          ui: { confirm: async () => true },
        }),
      ).rejects.toThrow(/codified promote requires an interactive session/);
    });
  });

  it("promote with confirm + secretsBound + landed clean → probationary and ledger by nonce", async () => {
    await withTmpHome(async (home) => {
      await saveRegistry(home, registryOf(entry({ name: "bump-package-version" })));
      const titles: string[] = [];
      const out = await runCodified(
        parseFactoryArgs("codified promote bump-package-version@1"),
        depsFor(home),
        {
          hasUI: true,
          ui: {
            confirm: async (title) => {
              titles.push(title);
              return true;
            },
          },
        },
      );
      expect(titles.some((t) => t.includes("bump-package-version@1"))).toBe(true);
      expect(out).toMatch(/probationary/);
      const reg = await loadRegistry(home);
      expect(reg.entries["bump-package-version"]?.state).toBe("probationary");
      expect(reg.entries["bump-package-version"]?.history.at(-1)?.by).toBe("nonce");
      const ledger = await readCodifiedLedger(home);
      expect(ledger.at(-1)?.by).toBe("nonce");
      expect(ledger.at(-1)?.to).toBe("probationary");
    });
  });

  it("refuses promote when secrets are unbound", async () => {
    await withTmpHome(async (home) => {
      await saveRegistry(
        home,
        registryOf(entry({ name: "bump-package-version", secretsBound: false })),
      );
      await expect(
        runCodified(
          parseFactoryArgs("codified promote bump-package-version@1"),
          depsFor(home),
          ui(),
        ),
      ).rejects.toThrow(/unbound/i);
    });
  });

  it("refuses human-modified landings and prints the re-validate instruction", async () => {
    await withTmpHome(async (home) => {
      await saveRegistry(
        home,
        registryOf(entry({ name: "bump-package-version", landedAs: "human-modified" })),
      );
      const out = await runCodified(
        parseFactoryArgs("codified promote bump-package-version@1"),
        depsFor(home),
        ui(),
      );
      expect(out).toMatch(/re-enter validate|human-modified/i);
      const reg = await loadRegistry(home);
      expect(reg.entries["bump-package-version"]?.state).toBe("staged");
    });
  });

  it("why uses the matcher to explain a hit and a miss", async () => {
    await withTmpHome(async (home) => {
      await saveRegistry(home, registryOf(entry({ name: "bump-package-version", state: "active" })));
      const hit = await runCodified(
        parseFactoryArgs("codified why chore: bump pkg to 1.3.0"),
        depsFor(home),
        ui(),
      );
      expect(hit).toMatch(/bump-package-version/);
      expect(hit).toMatch(/hit/i);
      const miss = await runCodified(
        parseFactoryArgs("codified why feat: rewrite the renderer"),
        depsFor(home),
        ui(),
      );
      expect(miss).toMatch(/miss|no match/i);
    });
  });
});
