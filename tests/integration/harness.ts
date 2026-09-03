import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runsDir } from "../../src/home.js";
import { loadEffectiveLanes } from "../../src/lanes/index.js";
import { HeadlessExecutor } from "../../src/runtime/headless.js";
import { LocalAdapter } from "../../src/trackers/local.js";
import { GitWorktreeProvider } from "../../src/workspace/git-provider.js";
import { loadAgentDefs, packageRoot } from "../../src/controller/agents.js";
import { makeEngine } from "../../src/controller/register.js";
import { sandboxProfileForRun, type FactoryDeps, type FactoryScheduler } from "../../src/controller/lane-runner.js";
import { writeGlobalConfig } from "../../src/setup/writers.js";
import type { PrClient } from "../../src/git/pr.js";
import type { AnalystPort } from "../../src/intake/analyze.js";
import { Scheduler, makeOnTicket } from "../../src/scheduler/poller.js";
import type { TrackerRegistry } from "../../src/trackers/discovery.js";

const exec = promisify(execFile);
const require_ = createRequire(import.meta.url);

export function stubPiPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "helpers", "stub-pi.mjs");
}

export function vitestCheckArgv(junitPath: string): string[] {
  const cli = join(dirname(require_.resolve("vitest/package.json")), "vitest.mjs");
  return [
    process.execPath,
    cli,
    "run",
    "--root",
    ".",
    "--globals",
    "--reporter=junit",
    `--outputFile=${junitPath}`,
  ];
}

export async function writeScenario(dir: string, scenario: Record<string, unknown>): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "scenario.json");
  await writeFile(path, JSON.stringify(scenario, null, 2), "utf8");
  return path;
}

const GIT_IDENT = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

/**
 * Layer 2 (global): operator + the repo-scope defaults the fixture does not commit.
 * Layer 3 (committed): the checks[] entry, rewritten into the fixture's own .pi/factory.json
 * and committed — a committed value beats the global defaults block, so the check has to
 * live there to take effect at all.
 */
export async function writeFactoryTestConfig(
  home: string,
  repo: string,
  opts: { steering: "always" | "elevated" | "never"; junitPath: string; sandbox?: "required" | "best-effort" | "off" },
): Promise<{ globalPath: string; committedPath: string }> {
  const globalPath = await writeGlobalConfig(home, {
    operator: { maxLanes: 1, maxLanesPerRepo: 1 },
    defaults: {
      steering: opts.steering,
      planApproval: "never",
      sandbox: opts.sandbox ?? "off",
      setupTimeoutSeconds: 60,
      stageTimeoutSeconds: 60,
      checksTimeoutSeconds: 180,
      checksConcurrency: 1,
    },
    repos: [
      { path: repo, remote: "origin", tracker: "local", project: "fixture", label: "factory:ready" },
    ],
  });

  await exec("git", ["-C", repo, "config", "user.name", "Fixture"]);
  await exec("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  await exec("git", ["-C", repo, "config", "commit.gpgsign", "false"]);

  const committedPath = join(repo, ".pi", "factory.json");
  const committed = JSON.parse(await readFile(committedPath, "utf8")) as Record<string, unknown>;
  const next = {
    ...committed,
    checks: [
      {
        name: "vitest",
        argv: vitestCheckArgv(opts.junitPath),
        reporter: "junit",
        junitPath: opts.junitPath,
        timeoutSeconds: 180,
      },
    ],
    writeRoots: {
      chore: [
        "src/**",
        "lib/**",
        "packages/*/src/**",
        "apps/*/src/**",
        "tests/**",
        "docs/**",
        "README.md",
        "CHANGELOG.md",
        "scripts/**",
        ".github/**",
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "pyproject.toml",
        "poetry.lock",
        "requirements*.txt",
      ],
    },
  };
  await writeFile(committedPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await exec("git", ["-C", repo, ...GIT_IDENT, "add", ".pi/factory.json"], { encoding: "utf8" });
  await exec("git", ["-C", repo, ...GIT_IDENT, "commit", "-m", "chore: point fixture checks at the harness vitest"], {
    encoding: "utf8",
  });
  return { globalPath, committedPath };
}

export async function buildTestDeps(opts: {
  home: string;
  repo: string;
  scenarioPath: string;
  /** When true, wrap stub-pi with the same sandbox callback production uses. */
  sandbox?: boolean;
  adapters?: TrackerRegistry;
  pr?: PrClient;
  scheduler?: FactoryScheduler;
  analyst?: AnalystPort;
}): Promise<FactoryDeps> {
  const runs = runsDir();
  await mkdir(join(runs, "_factory"), { recursive: true, mode: 0o700 });
  const root = packageRoot();
  const lanes = await loadEffectiveLanes([join(root, "src", "assets", "lanes.yaml")]);
  const agents = await loadAgentDefs({
    root,
    models: {},
    defaultModel: "stub-model",
    required: ["planner", "implementer", "reviewer", "judge"],
  });
  const tracker = new LocalAdapter(runs);
  const adapters = opts.adapters;
  const scheduler =
    opts.scheduler ??
    (adapters === undefined
      ? undefined
      : new Scheduler({
          runsDir: runs,
          adapters,
          pollIntervalSeconds: 60,
          onTicket: makeOnTicket({
            runsDir: runs,
            adapterFor: (id) => adapters.get(id),
            analyst: opts.analyst,
            authorized: async (ticket, id) => {
              const adapter = adapters.get(id);
              if (adapter === undefined) return false;
              if (ticket.ref.tracker === "local") return true;
              const labeler = await adapter.labelerOf(ticket.ref, "factory:ready");
              return adapter.isAuthorized(labeler?.login ?? ticket.author);
            },
          }),
        }));
  return {
    home: opts.home,
    runsDir: runs,
    projectRootDefault: root,
    engine: makeEngine(runs),
    executor: new HeadlessExecutor({
      sandbox: opts.sandbox === true ? (req) => sandboxProfileForRun(req, opts.home) : null,
      extraEnv: { PI_SDLC_STUB_SCENARIO: opts.scenarioPath },
      pollMs: 50,
    }),
    provider: new GitWorktreeProvider({ home: opts.home }),
    tracker,
    agents,
    lanes,
    piBinary: stubPiPath(),
    repos: [opts.repo],
    ...(adapters === undefined ? {} : { adapters }),
    ...(opts.pr === undefined ? {} : { pr: opts.pr }),
    ...(scheduler === undefined ? {} : { scheduler }),
    ...(opts.analyst === undefined ? {} : { analyst: opts.analyst }),
  };
}

export async function branchTree(repoOrBare: string, branch: string): Promise<string[]> {
  const { stdout } = await exec("git", ["--git-dir", repoOrBare, "ls-tree", "-r", "--name-only", branch], {
    encoding: "utf8",
  });
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

export async function remoteTip(bare: string, branch: string): Promise<string> {
  const { stdout } = await exec("git", ["--git-dir", bare, "rev-parse", `refs/heads/${branch}`], {
    encoding: "utf8",
  });
  return stdout.trim();
}
