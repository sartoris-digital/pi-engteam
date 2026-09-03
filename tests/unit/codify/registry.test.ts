import { describe, expect, it } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULTS } from "../../../src/config/defaults.js";
import { FACTORY_EVENTS } from "../../../src/observer/events.js";
import {
  CODIFIED_EVENTS,
  CODIFIED_OUTCOME_EVENTS,
  CODIFIED_STATE_EVENTS,
} from "../../../src/codify/events.js";
import {
  appendCodifiedLedger,
  codifiedLedgerPath,
  readCodifiedLedger,
} from "../../../src/codify/ledger.js";
import {
  applyTransition,
  canPromote,
  emptyRegistry,
  evictIfNeeded,
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
  loadRegistry,
  markStale,
  maybeActivate,
  maybeDemote,
  recordHit,
  registryPath,
  saveRegistry,
  transition,
  type Registry,
  type RegistryEntry,
  type RegistryState,
  type TransitionBy,
} from "../../../src/codify/registry.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const CFG = DEFAULTS.operator.codify;

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
    validation: { baseSha: sha("base"), uvVersion: "0.4.0", formatterVersion: "3.1.0" },
    secretsBound: true,
    landedAs: "clean",
    matcher: { titlePatterns: ["chore: bump .+"], planStepPatterns: [], pathGlobs: ["package.json"] },
    writeGlobs: ["package.json"],
    readGlobs: ["package.json"],
    fixtureIds: [],
    stats: {
      exact: 0,
      partial: 0,
      shadowAgree: 0,
      shadowDisagree: 0,
      preconditionRefusals: 0,
      failures: 0,
      recentHits: [],
      savedUsd: 0,
      savedWallSeconds: 0,
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

describe("LEGAL_TRANSITIONS", () => {
  it("freezes the v1.5 lifecycle graph", () => {
    expect([...LEGAL_TRANSITIONS].map(([from, to]) => `${from}→${to}`).sort()).toEqual(
      [
        "active→demoted",
        "active→drifted",
        "active→probationary",
        "active→retired",
        "assist→retired",
        "demoted→probationary",
        "demoted→retired",
        "drifted→probationary",
        "drifted→retired",
        "probationary→active",
        "probationary→assist",
        "probationary→demoted",
        "probationary→drifted",
        "probationary→retired",
        "staged→probationary",
        "staged→rejected",
      ].sort(),
    );
  });
});

describe("transition", () => {
  const edges: Array<[RegistryState, RegistryState, TransitionBy, string]> = [
    ["staged", "probationary", "nonce", "promote"],
    ["staged", "rejected", "system", "not-codifiable"],
    ["probationary", "active", "shadow", "shadowAgree"],
    ["probationary", "assist", "system", "residuals"],
    ["probationary", "demoted", "system", "failures"],
    ["probationary", "retired", "system", "safety-adjacent"],
    ["probationary", "drifted", "system", "sha-mismatch"],
    ["active", "demoted", "system", "consecutive-fail"],
    ["active", "drifted", "system", "smoke-fail"],
    ["active", "retired", "system", "stale"],
    ["active", "probationary", "system", "survival-reverted"],
    ["demoted", "retired", "system", "one-more-fail"],
    ["demoted", "probationary", "system", "retry"],
    ["drifted", "probationary", "system", "re-validate"],
    ["drifted", "retired", "system", "give-up"],
    ["assist", "retired", "system", "terminal"],
  ];

  it("each legal edge appends history and returns the factory.codified.* event", async () => {
    await withTmpHome(async (home) => {
      for (const [from, to, by, reason] of edges) {
        const name = `tool-${from}-${to}`;
        const reg = registryOf(entry({ name, state: from }));
        await saveRegistry(home, reg);
        const result = await applyTransition(home, name, to, by, reason, NOW);
        expect(result.event).toBe(`factory.codified.${to}`);
        const updated = result.registry.entries[name];
        expect(updated?.state).toBe(to);
        expect(updated?.history).toEqual([
          { at: NOW.toISOString(), from, to, by, reason },
        ]);
      }
      const ledger = await readCodifiedLedger(home);
      expect(ledger).toHaveLength(edges.length);
      expect(ledger.map((line) => line.event)).toEqual(edges.map(([, to]) => `factory.codified.${to}`));
    });
  });

  it("throws on illegal staged → active", () => {
    const reg = registryOf(entry({ name: "bump", state: "staged" }));
    expect(() => transition(reg, "bump", "active", "nonce", "skip")).toThrow(IllegalTransitionError);
    expect(() => transition(reg, "bump", "active", "nonce", "skip")).toThrow(/staged → active/);
    expect(reg.entries.bump?.state).toBe("staged");
    expect(reg.entries.bump?.history).toEqual([]);
  });

  it("keeps assist terminal except retire (no assist → active in v1.5)", () => {
    const reg = registryOf(entry({ name: "assist-tool", state: "assist" }));
    expect(() => transition(reg, "assist-tool", "active", "shadow", "cleared")).toThrow(IllegalTransitionError);
    const retired = transition(reg, "assist-tool", "retired", "system", "terminal");
    expect(retired.entries["assist-tool"]?.state).toBe("retired");
  });

  it("allows any → retired on safety", () => {
    for (const from of ["staged", "probationary", "active", "assist", "demoted", "drifted", "rejected"] as const) {
      const reg = registryOf(entry({ name: "x", state: from }));
      const next = transition(reg, "x", "retired", "safety", "codified-safety", NOW);
      expect(next.entries.x?.state).toBe("retired");
      expect(next.entries.x?.history.at(-1)).toMatchObject({ by: "safety", to: "retired" });
    }
  });
});

describe("canPromote", () => {
  it("is ok only when secrets are bound, landed clean, and UI is present", () => {
    const ok = entry({ name: "bump", secretsBound: true, landedAs: "clean" });
    expect(canPromote(ok, { hasUI: true })).toEqual({ ok: true });
  });

  it("returns unbound-secrets | not-landed | human-modified | no-ui", () => {
    expect(canPromote(entry({ name: "a", secretsBound: false, landedAs: "clean" }), { hasUI: true })).toEqual({
      ok: false,
      reason: "unbound-secrets",
    });
    expect(canPromote(entry({ name: "b", secretsBound: true, landedAs: undefined }), { hasUI: true })).toEqual({
      ok: false,
      reason: "not-landed",
    });
    expect(canPromote(entry({ name: "c", secretsBound: true, landedAs: "partial" }), { hasUI: true })).toEqual({
      ok: false,
      reason: "not-landed",
    });
    expect(canPromote(entry({ name: "d", secretsBound: true, landedAs: "human-modified" }), { hasUI: true })).toEqual({
      ok: false,
      reason: "human-modified",
    });
    expect(canPromote(entry({ name: "e", secretsBound: true, landedAs: "clean" }), { hasUI: false })).toEqual({
      ok: false,
      reason: "no-ui",
    });
  });
});

describe("recordHit / maybeDemote / maybeActivate", () => {
  it("two consecutive failures from active → demoted; one more → retired", () => {
    let e = entry({ name: "bump", state: "active" });
    e = recordHit(e, { kind: "fail" }, NOW);
    e = maybeDemote(e, CFG);
    expect(e.state).toBe("active");
    e = recordHit(e, { kind: "fail" }, NOW);
    e = maybeDemote(e, CFG);
    expect(e.state).toBe("demoted");
    expect(e.stats.failures).toBe(2);
    expect(e.stats.recentHits).toEqual(["fail", "fail"]);
    e = recordHit(e, { kind: "fail" }, NOW);
    e = maybeDemote(e, CFG);
    expect(e.state).toBe("retired");
  });

  it("demotes when demoteAfterFailures occur in the last 10 hits", () => {
    let e = entry({ name: "bump", state: "active" });
    e = recordHit(e, { kind: "exact" }, NOW);
    e = recordHit(e, { kind: "fail" }, NOW);
    e = maybeDemote(e, { ...CFG, demoteAfterFailures: 2 });
    expect(e.state).toBe("active");
    e = recordHit(e, { kind: "exact" }, NOW);
    e = recordHit(e, { kind: "fail" }, NOW);
    e = maybeDemote(e, { ...CFG, demoteAfterFailures: 2 });
    expect(e.state).toBe("demoted");
  });

  it("retires immediately on a safety hit", () => {
    let e = entry({ name: "bump", state: "active" });
    e = recordHit(e, { kind: "fail" }, NOW);
    e = maybeDemote(e, CFG, { safety: true });
    expect(e.state).toBe("retired");
    expect(e.history.at(-1)).toMatchObject({ by: "safety", to: "retired" });
  });

  it("activates a stage-tool after shadowAgree >= N and zero disagreements", () => {
    let e = entry({ name: "bump", state: "probationary" });
    e = recordHit(e, { kind: "shadow-agree" }, NOW);
    expect(maybeActivate(e, CFG).state).toBe("probationary");
    e = recordHit(e, { kind: "shadow-agree" }, NOW);
    const active = maybeActivate(e, CFG);
    expect(active.state).toBe("active");
    expect(active.history.at(-1)).toMatchObject({ from: "probationary", to: "active", by: "shadow" });
  });

  it("does not activate a task-tool without two supervised successes and bound secrets", () => {
    let e = entry({
      name: "sync",
      class: "task-tool",
      state: "probationary",
      secretsBound: false,
      supervisedSuccesses: 0,
    });
    e = recordHit(e, { kind: "shadow-agree" }, NOW);
    e = recordHit(e, { kind: "shadow-agree" }, NOW);
    expect(maybeActivate(e, CFG).state).toBe("probationary");
    e = { ...e, secretsBound: true, supervisedSuccesses: 2 };
    expect(maybeActivate(e, CFG).state).toBe("active");
  });
});

describe("evictIfNeeded", () => {
  it("caps maxActivePerRepo 25 and maxActiveGlobal 50 by default", () => {
    expect(CFG.maxActivePerRepo).toBe(25);
    expect(CFG.maxActiveGlobal).toBe(50);
  });

  it("evicts highest fixture overlap then lowest 0.5*reliability + 0.3*usage + 0.2*recency", () => {
    const shared = ["f1", "f2", "f3"];
    const high = entry({
      name: "keep-high",
      state: "active",
      fixtureIds: shared,
      stats: {
        exact: 20,
        partial: 0,
        shadowAgree: 2,
        shadowDisagree: 0,
        preconditionRefusals: 0,
        failures: 0,
        recentHits: ["ok", "ok", "ok", "ok", "ok"],
        savedUsd: 10,
        savedWallSeconds: 100,
        lastHitAt: NOW.toISOString(),
      },
    });
    const overlapLow = entry({
      name: "evict-me",
      state: "active",
      fixtureIds: shared,
      stats: {
        exact: 1,
        partial: 0,
        shadowAgree: 0,
        shadowDisagree: 0,
        preconditionRefusals: 0,
        failures: 4,
        recentHits: ["fail", "fail", "fail", "fail"],
        savedUsd: 0,
        savedWallSeconds: 0,
        lastHitAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unique = entry({
      name: "unique",
      state: "active",
      repo: "acme/other",
      fixtureIds: ["only-me"],
      stats: {
        exact: 0,
        partial: 0,
        shadowAgree: 0,
        shadowDisagree: 0,
        preconditionRefusals: 0,
        failures: 8,
        recentHits: ["fail"],
        savedUsd: 0,
        savedWallSeconds: 0,
        lastHitAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const next = evictIfNeeded(registryOf(high, overlapLow, unique), {
      ...CFG,
      maxActiveGlobal: 2,
      maxActivePerRepo: 2,
    });
    expect(next.entries["evict-me"]?.state).toBe("retired");
    expect(next.entries["keep-high"]?.state).toBe("active");
    expect(next.entries.unique?.state).toBe("active");
    expect(next.entries["evict-me"]?.history.at(-1)?.reason).toMatch(/evict/i);
  });

  it("enforces maxActivePerRepo independently of global", () => {
    const tools = Array.from({ length: 3 }, (_, i) =>
      entry({
        name: `r${i}`,
        state: "active",
        repo: "acme/app",
        fixtureIds: i === 2 ? ["shared", "x"] : ["shared"],
        stats: {
          exact: i === 0 ? 10 : 0,
          partial: 0,
          shadowAgree: 0,
          shadowDisagree: 0,
          preconditionRefusals: 0,
          failures: i === 2 ? 5 : 0,
          recentHits: i === 2 ? ["fail", "fail"] : ["ok"],
          savedUsd: 0,
          savedWallSeconds: 0,
          lastHitAt: i === 0 ? NOW.toISOString() : "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    const next = evictIfNeeded(registryOf(...tools), { ...CFG, maxActivePerRepo: 2, maxActiveGlobal: 50 });
    const active = Object.values(next.entries).filter((e) => e.state === "active");
    expect(active).toHaveLength(2);
    expect(next.entries.r2?.state).toBe("retired");
  });
});

describe("markStale", () => {
  it("retires entries with no hit in staleDays 90", () => {
    expect(CFG.staleDays).toBe(90);
    const stale = entry({
      name: "old",
      state: "active",
      stats: {
        exact: 1,
        partial: 0,
        shadowAgree: 0,
        shadowDisagree: 0,
        preconditionRefusals: 0,
        failures: 0,
        recentHits: ["ok"],
        savedUsd: 0,
        savedWallSeconds: 0,
        lastHitAt: "2026-05-01T00:00:00.000Z",
      },
    });
    const fresh = entry({
      name: "fresh",
      state: "active",
      stats: {
        exact: 1,
        partial: 0,
        shadowAgree: 0,
        shadowDisagree: 0,
        preconditionRefusals: 0,
        failures: 0,
        recentHits: ["ok"],
        savedUsd: 0,
        savedWallSeconds: 0,
        lastHitAt: "2026-08-20T00:00:00.000Z",
      },
    });
    const next = markStale(registryOf(stale, fresh), CFG, NOW);
    expect(next.entries.old?.state).toBe("retired");
    expect(next.entries.old?.history.at(-1)?.reason).toMatch(/stale/i);
    expect(next.entries.fresh?.state).toBe("active");
  });
});

describe("registry persistence", () => {
  it("writes ${home}/codified/registry.json mode 0600 via tmp+rename", async () => {
    await withTmpHome(async (home) => {
      const path = registryPath(home);
      expect(path).toBe(join(home, "codified", "registry.json"));
      const reg = registryOf(entry({ name: "bump", state: "staged" }));
      await saveRegistry(home, reg);
      const st = await stat(path);
      expect(st.mode & 0o777).toBe(0o600);
      const loaded = await loadRegistry(home);
      expect(loaded.entries.bump?.name).toBe("bump");
      expect(await loadRegistry(join(home, "missing-home"))).toEqual(emptyRegistry());
    });
  });

  it("replaces a corrupt tmp file atomically and does not leave .tmp as authority", async () => {
    await withTmpHome(async (home) => {
      await mkdir(join(home, "codified"), { recursive: true, mode: 0o700 });
      await writeFile(join(home, "codified", `registry.json.${process.pid}.tmp`), "{broken", "utf8");
      await saveRegistry(home, registryOf(entry({ name: "ok", state: "staged" })));
      const raw = await readFile(registryPath(home), "utf8");
      expect(JSON.parse(raw).entries.ok.state).toBe("staged");
    });
  });
});

describe("codified ledger", () => {
  it("appends JSONL under ${home}/codified/codified-ledger.jsonl", async () => {
    await withTmpHome(async (home) => {
      expect(codifiedLedgerPath(home)).toBe(join(home, "codified", "codified-ledger.jsonl"));
      expect(await readCodifiedLedger(home)).toEqual([]);
      await appendCodifiedLedger(home, {
        at: NOW.toISOString(),
        name: "bump",
        version: 1,
        from: "staged",
        to: "probationary",
        by: "nonce",
        reason: "promote",
        event: "factory.codified.probationary",
      });
      const lines = (await readFile(codifiedLedgerPath(home), "utf8")).split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}").event).toBe("factory.codified.probationary");
    });
  });
});

describe("CODIFIED_EVENTS", () => {
  it("names every registry state plus mine/assess/generate/validate outcomes", () => {
    expect([...CODIFIED_STATE_EVENTS]).toEqual([
      "factory.codified.staged",
      "factory.codified.probationary",
      "factory.codified.active",
      "factory.codified.assist",
      "factory.codified.demoted",
      "factory.codified.retired",
      "factory.codified.rejected",
      "factory.codified.drifted",
    ]);
    expect([...CODIFIED_OUTCOME_EVENTS]).toEqual([
      "factory.codified.mine",
      "factory.codified.assess",
      "factory.codified.generate",
      "factory.codified.validate",
    ]);
    expect(CODIFIED_EVENTS).toContain("factory.codified.blocked");
    for (const name of CODIFIED_EVENTS) expect(FACTORY_EVENTS).toContain(name);
  });
});
