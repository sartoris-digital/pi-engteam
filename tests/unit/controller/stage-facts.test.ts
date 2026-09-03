import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  STAGE_FACTS_FILE,
  buildStageFacts,
  stageFactsPath,
  writeStageFacts,
  type StageFacts,
} from "../../../src/controller/stage-facts.js";
import { makeStageHooks } from "../../../src/controller/stage-hooks.js";
import { generatedMarker } from "../../../src/runtime/marker.js";
import { stripMarker } from "../../../src/engine/state.js";
import { makeRepoConfig, makeRunState, makeStepContext } from "../../helpers/steer-fixtures.js";
import type { RuleRecord } from "../../../src/rules/schema.js";
import type { StageDef } from "../../../src/lanes/schema.js";
import type { WorkerExecutor, WorkerResult } from "../../../src/runtime/types.js";

function rule(over: Partial<RuleRecord> & { id: string; text: string }): RuleRecord {
  return {
    scope: { repo: "*", lane: "*", stage: ["*"], kind: "*", paths: [] },
    class: "constraint",
    enforce: ["prompt"],
    createdAt: "2026-09-02T00:00:00.000Z",
    author: "operator",
    status: "active",
    ...over,
  };
}

describe("buildStageFacts", () => {
  it("carries the host-owned facts a worker would otherwise guess at", () => {
    const facts = buildStageFacts({
      state: makeRunState({ lane: "feature", kind: "feature", tier: "elevated", ticket: { tracker: "github", ref: "github:acme/app#12", title: "t" } }),
      cfg: makeRepoConfig({
        checks: [
          { name: "typecheck", argv: ["pnpm", "typecheck"], reporter: "none", timeoutSeconds: 300 },
          { name: "unit", argv: ["pnpm", "test"], reporter: "junit", timeoutSeconds: 900, junitPath: "junit.xml" },
        ],
      }),
      stage: "implement",
      rules: [rule({ id: "r-1", text: "Always add a changelog entry." })],
    });
    expect(facts).toEqual({
      lane: "feature",
      stage: "implement",
      kind: "feature",
      tier: "elevated",
      ticketRef: "github:acme/app#12",
      branching: { base: "main", target: "main" },
      testDir: "tests",
      testPattern: "**/*.test.ts",
      writeRoots: ["src/**", "tests/**"],
      checks: ["typecheck", "unit"],
      maxDiffLines: 800,
      maxChangedFiles: 20,
      rules: [{ id: "r-1", text: "Always add a changelog entry." }],
    } satisfies StageFacts);
  });

  it("carries only the write roots for this run's kind", () => {
    const facts = buildStageFacts({
      state: makeRunState({ kind: "chore" }),
      cfg: makeRepoConfig(),
      stage: "implement",
    });
    expect(facts.writeRoots).toEqual(["docs/**", "README.md"]);
    expect(facts.rules).toEqual([]);
  });

  it("scopes rules the same way the prompt block does", () => {
    const rules = [
      rule({ id: "r-plan", text: "planning only", scope: { repo: "*", lane: "*", stage: ["plan"], kind: "*", paths: [] } }),
      rule({ id: "r-impl", text: "implement only", scope: { repo: "*", lane: "*", stage: ["implement"], kind: "*", paths: [] } }),
      rule({ id: "r-bug", text: "bugs only", scope: { repo: "*", lane: "*", stage: ["*"], kind: "bug", paths: [] } }),
      rule({ id: "r-dead", text: "retired", status: "retired" }),
    ];
    const facts = buildStageFacts({ state: makeRunState({ kind: "chore" }), cfg: makeRepoConfig(), stage: "implement", rules });
    expect(facts.rules.map((r) => r.id)).toEqual(["r-impl"]);
  });

  it("never lets a secret: reference from the config reach the facts", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pi-sdlc-facts-secret-"));
    try {
      const facts = buildStageFacts({
        state: makeRunState({
          kind: "feature",
          ticket: { tracker: "github", ref: "github:acme/app#12", title: "token is secret:vault/github-token" },
        }),
        cfg: makeRepoConfig({
          remote: "https://x-access-token:secret:vault/gh-pat@github.com/acme/app.git",
          checks: [
            {
              name: "deploy",
              argv: ["deploy", "--token", "secret:vault/deploy-key"],
              reporter: "none",
              timeoutSeconds: 60,
            },
          ],
          setupCommand: ["npm", "ci", "--//registry:_authToken=secret:vault/npm-token"],
          laneEnv: { template: "API_KEY=secret:vault/api-key" },
        }),
        stage: "implement",
        rules: [rule({ id: "r-leak", text: "use secret:vault/api-key for the API" })],
      });
      const path = await writeStageFacts(runDir, facts);
      const raw = await readFile(path, "utf8");
      expect(raw).not.toContain("secret:");
      expect(raw).not.toContain("vault/");
      expect(raw).not.toContain("x-access-token");
      expect(raw).not.toContain("registry:_authToken");
      expect(raw).not.toContain("API_KEY");
      // Structural: argv, remote, setupCommand and laneEnv have no field in StageFacts at all.
      expect(Object.keys(JSON.parse(stripMarker(raw)) as object).sort()).toEqual([
        "branching",
        "checks",
        "kind",
        "lane",
        "maxChangedFiles",
        "maxDiffLines",
        "rules",
        "stage",
        "testDir",
        "testPattern",
        "ticketRef",
        "tier",
        "writeRoots",
      ]);
      expect(facts.rules[0]?.text).toBe("use [redacted] for the API");
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

describe("writeStageFacts", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = join(await mkdtemp(join(tmpdir(), "pi-sdlc-facts-")), "runs", "run-1");
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(runDir, "..", ".."), { recursive: true, force: true });
  });

  it("writes <runDir>/facts.json 0600 with the generated marker as its first line", async () => {
    const facts = buildStageFacts({ state: makeRunState(), cfg: makeRepoConfig(), stage: "implement" });
    const path = await writeStageFacts(runDir, facts);
    expect(path).toBe(join(runDir, STAGE_FACTS_FILE));
    expect(stageFactsPath(runDir)).toBe(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n")[0]).toBe(generatedMarker(basename(runDir)));
    expect(JSON.parse(stripMarker(raw))).toEqual(facts);
  });

  it("overwrites a stale facts file from an earlier round", async () => {
    await writeStageFacts(runDir, buildStageFacts({ state: makeRunState(), cfg: makeRepoConfig(), stage: "plan" }));
    await writeStageFacts(runDir, buildStageFacts({ state: makeRunState(), cfg: makeRepoConfig(), stage: "implement" }));
    const parsed = JSON.parse(stripMarker(await readFile(stageFactsPath(runDir), "utf8"))) as StageFacts;
    expect(parsed.stage).toBe("implement");
    expect((await stat(stageFactsPath(runDir))).mode & 0o777).toBe(0o600);
  });
});

describe("agentStep facts", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = join(await mkdtemp(join(tmpdir(), "pi-sdlc-facts-hooks-")), "runs", "run-1");
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(runDir, "..", ".."), { recursive: true, force: true });
  });

  function executor(result: WorkerResult): WorkerExecutor {
    return { run: async () => result };
  }

  it("writes facts.json for every dispatched agent stage", async () => {
    const hooks = makeStageHooks({
      executor: executor({
        verdict: { step: "plan", verdict: "PASS" },
        exitCode: 0,
        timedOut: false,
        stderrTail: "",
        durationMs: 1,
      }),
      agents: [{ name: "planner", model: "stub", promptPath: "/dev/null", tools: ["read"], stageClass: "read-only" }],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
      rules: [rule({ id: "r-1", text: "Always add a changelog entry." })],
    });
    const run = hooks.agentStep({ name: "plan", agent: "planner", gates: [], onFail: "fix-round" } as StageDef, "plan");
    const ctx = makeStepContext(runDir, { state: { runId: "run-1", steps: [], kind: "feature", lane: "feature" } });
    await mkdir(ctx.workspaceDir, { recursive: true });
    await run(ctx);

    const path = stageFactsPath(runDir);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, "utf8");
    expect(raw.startsWith(`${generatedMarker("run-1")}\n`)).toBe(true);
    const parsed = JSON.parse(stripMarker(raw)) as StageFacts;
    expect(parsed.stage).toBe("plan");
    expect(parsed.kind).toBe("feature");
    expect(parsed.testDir).toBe("tests");
    expect(parsed.branching).toEqual({ base: "main", target: "main" });
    expect(parsed.writeRoots).toEqual(["src/**", "tests/**"]);
    expect(parsed.rules).toEqual([{ id: "r-1", text: "Always add a changelog entry." }]);
  });
});
