import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveRepoConfig } from "../../../src/config/schema.js";
import { computeIterationBudget, isTerminalStep } from "../../../src/engine/budget.js";
import type { StartRunParams } from "../../../src/engine/engine.js";
import type { Step, Transition, WhenScope, Workflow } from "../../../src/engine/types.js";

const created: string[] = [];

export async function tmpRunsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sdlc-engine-"));
  created.push(dir);
  return dir;
}

export async function cleanupTmpDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Matches the contract's EffectiveRepoConfig field for field. */
export function makeTestCfg(repoRoot = "/tmp/repo"): EffectiveRepoConfig {
  return {
    repoRoot,
    remote: "origin",
    branching: {
      base: "main",
      target: "main",
      nameTemplate: "factory/{tracker}-{id}-{slug}",
      titleTemplate: "{title} ({ref})",
      draftPolicy: "elevated",
      linkStyle: "closes",
    },
    checks: [],
    testDir: "tests",
    testPattern: "**/*.test.ts",
    testInfra: [],
    setupTimeoutSeconds: 600,
    allowInstallScripts: false,
    writeRoots: { feature: ["src/**"], enhancement: ["src/**"], bug: ["src/**"], chore: ["src/**"] },
    riskPaths: [],
    securityPaths: [],
    exclusivePaths: [],
    generatedPaths: [],
    maxDiffLines: 400,
    maxChangedFiles: 15,
    steering: "always",
    planApproval: "never",
    stageTimeoutSeconds: 1800,
    checksTimeoutSeconds: 900,
    checksConcurrency: 1,
    generatedDocPatterns: [],
    sandbox: "off",
  };
}

export function makeStep(spec: Partial<Step> & { name: string }, run?: Step["run"]): Step {
  const base: Step = {
    name: spec.name,
    kind: spec.kind ?? "host",
    gates: [],
    onFail: "continue",
    run: run ?? spec.run ?? (async () => ({ verdict: "PASS" })),
  };
  const merged: Step = { ...base, ...spec, run: base.run };
  if (merged.kind === "host" && merged.host === undefined) merged.host = spec.name;
  return merged;
}

/** Transitions the way compile.ts generates them: PASS → next (halt after the last), FAIL per onFail. */
export function linearTransitions(steps: Step[], fixTarget?: string): Transition[] {
  const active = steps.filter((s) => !isTerminalStep(s));
  const out: Transition[] = [];
  active.forEach((s, i) => {
    const next = active[i + 1]?.name ?? "halt";
    out.push({ from: s.name, when: (r) => r.verdict === "PASS", to: next });
    if (s.onFail === "fix-round" && fixTarget) out.push({ from: s.name, when: (r) => r.verdict !== "PASS", to: fixTarget });
    else if (s.onFail === "continue") out.push({ from: s.name, when: (r) => r.verdict !== "PASS", to: next });
    else out.push({ from: s.name, when: (r) => r.verdict !== "PASS", to: "escalate" });
  });
  return out;
}

export interface WorkflowOptions {
  fixRounds?: number;
  fixTarget?: string;
  maxWallSeconds?: number;
  maxCostUsd?: number;
  transitions?: Transition[];
}

export function makeWorkflow(lane: string, steps: Step[], opts: WorkflowOptions = {}): Workflow {
  const w: Workflow = {
    name: `factory-sdlc:${lane}@deadbeef`,
    lane,
    laneClass: "build",
    steps,
    transitions: opts.transitions ?? linearTransitions(steps, opts.fixTarget),
    budget: {
      fixRounds: opts.fixRounds ?? 2,
      maxWallSeconds: opts.maxWallSeconds ?? 2700,
      maxCostUsd: opts.maxCostUsd ?? 8,
      maxIterations: 0,
    },
  };
  w.budget.maxIterations = computeIterationBudget(w);
  return w;
}

/** Synthetic build lane: plan, gate, steer(auto), implement, test, review, judge, publish + terminal escalate. */
export function buildLaneSteps(over: Partial<Record<string, Step["run"]>> = {}, log: string[] = []): Step[] {
  const pass =
    (name: string): Step["run"] =>
    async () => {
      log.push(name);
      return { verdict: "PASS" };
    };
  const runOf = (name: string): Step["run"] => over[name] ?? pass(name);
  return [
    makeStep({ name: "plan", kind: "agent", agent: "planner", onFail: "escalate:needs-decision" }, runOf("plan")),
    makeStep({ name: "gate", kind: "agent", agent: "tester", onFail: "escalate:gate-invalid" }, runOf("gate")),
    makeStep(
      { name: "steer", kind: "human", onFail: "escalate:needs-decision" },
      over["steer"] ??
        (async () => {
          log.push("steer");
          return { verdict: "PASS", evidence: { verdict: "AUTO" } };
        }),
    ),
    makeStep({ name: "implement", kind: "agent", agent: "implementer", verify: true, onFail: "fix-round" }, runOf("implement")),
    makeStep({ name: "test", kind: "host", host: "checks", onFail: "fix-round" }, runOf("test")),
    makeStep({ name: "review", kind: "agent", agent: "reviewer", onFail: "fix-round" }, runOf("review")),
    makeStep({ name: "judge", kind: "agent", agent: "judge", safetyGating: true, onFail: "fix-round" }, runOf("judge")),
    makeStep({ name: "publish", kind: "host", host: "publish", onFail: "escalate:publish-refused" }, runOf("publish")),
    makeStep({ name: "escalate", kind: "host", host: "escalate" }, runOf("escalate")),
  ];
}

/** Minimal `when` evaluator for tests: "true", "false", "tier == '<tier>'". */
export const evalWhenStub = (expr: string, scope: WhenScope): boolean => {
  if (expr === "true") return true;
  if (expr === "false") return false;
  const m = /^tier == '(\w+)'$/.exec(expr);
  if (m) return scope.tier === m[1];
  throw new Error(`evalWhenStub: unsupported expression ${JSON.stringify(expr)}`);
};

export function startParams(workflow: Workflow, over: Partial<StartRunParams> = {}): StartRunParams {
  return {
    workflow,
    cfg: makeTestCfg(),
    lane: workflow.lane,
    kind: "chore",
    tier: "low",
    ticket: { tracker: "local", ref: "local-1", title: "synthetic chore" },
    workspaceDir: "/tmp/ws",
    mainCheckout: "/tmp/repo",
    branch: "factory/local-1-synthetic-chore",
    baseSha: "0000000",
    cfgSha: "cfg0",
    budget: {
      fixRounds: workflow.budget.fixRounds,
      maxWallSeconds: workflow.budget.maxWallSeconds,
      maxCostUsd: workflow.budget.maxCostUsd,
    },
    ...over,
  };
}
