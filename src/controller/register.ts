import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../commands/index.js";
import { DEFAULTS } from "../config/defaults.js";
import type { TrackerEntry } from "../config/schema.js";
import { Engine } from "../engine/engine.js";
import { defaultVerify } from "../engine/verify.js";
import { checkpointCommit } from "../git/checkpoint.js";
import { ensureDirs, factoryHome, runsDir } from "../home.js";
import { evalWhen as evalLaneExpr, type WhenContext } from "../lanes/expr.js";
import { loadEffectiveLanes } from "../lanes/index.js";
import type { FactoryEvent } from "../observer/events.js";
import { HeadlessExecutor } from "../runtime/headless.js";
import { VisibleExecutor } from "../runtime/visible.js";
import type { WorkerExecutor } from "../runtime/types.js";
import { buildTrackerRegistry, detectTrackerFromRemote, githubConfigured } from "../trackers/discovery.js";
import { realGhExec } from "../trackers/gh.js";
import type { GitHubAdapterOptions } from "../trackers/github.js";
import { LocalAdapter } from "../trackers/local.js";
import { installInputGuard } from "../vault/input-guard.js";
import { Vault } from "../vault/vault.js";
import { GitWorktreeProvider } from "../workspace/git-provider.js";
import { herdrRunning, realHerdrCli, type HerdrCli } from "../workspace/herdr.js";
import { HerdrWorktreeProvider } from "../workspace/herdr-provider.js";
import type { WorkspaceProvider } from "../workspace/types.js";
import { loadAgentDefs, packageRoot, V1_AGENTS } from "./agents.js";
import { readJsonArtifact } from "./artifacts.js";
import { Scheduler, makeOnTicket } from "../scheduler/poller.js";
import { recoverFactory, pauseRunningEngineRuns } from "../scheduler/recover.js";
import { rehydrateOpenWorkflows, runObservers, sandboxProfileForRun, type FactoryDeps } from "./lane-runner.js";
import { workspaceFromState } from "./stage-hooks.js";

const execFileAsync = promisify(execFile);

const FACTORY_CO_AUTHOR = "Claude Fable 5.1 <noreply@anthropic.com>";

export function makeEngine(runs: string, opts: { coAuthoredBy: boolean }): Engine {
  return new Engine({
    runsDir: runs,
    evalWhen: (expr, scope) => evalLaneExpr(expr, scope as WhenContext),
    emit: (event: FactoryEvent) => {
      runObservers.get(event.runId)?.emit(event);
    },
    checkpoint: async (ctx, message) =>
      await checkpointCommit(
        workspaceFromState(ctx.state),
        message,
        {
          runId: ctx.state.runId,
          ...(opts.coAuthoredBy ? { coAuthoredBy: FACTORY_CO_AUTHOR } : {}),
        },
        { excludePatterns: ctx.cfg.generatedDocPatterns },
      ),
    verify: defaultVerify,
  });
}

interface GlobalOverlay {
  repos: string[];
  remotes: string[];
  trackers: TrackerEntry[];
  coAuthoredBy: boolean;
  worktreeRoot?: string;
  workers: "auto" | "visible" | "headless";
}

async function gitRemoteUrl(cwd: string, remote: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", remote], {
      timeout: 5000,
      encoding: "utf8",
    });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

async function readGlobalOverlay(home: string): Promise<GlobalOverlay> {
  try {
    const cfg = await readJsonArtifact<{
      operator?: {
        coAuthoredBy?: boolean;
        worktreeRoot?: string;
        trackers?: TrackerEntry[] | null;
        workers?: "auto" | "visible" | "headless";
      };
      repos?: { path: string; remote?: string }[];
    }>(join(home, "factory.json"));
    const worktreeRoot = cfg.operator?.worktreeRoot;
    const trackers = Array.isArray(cfg.operator?.trackers) ? cfg.operator.trackers : [];
    const remotes: string[] = [];
    for (const entry of cfg.repos ?? []) {
      if (typeof entry.remote === "string" && detectTrackerFromRemote(entry.remote) !== null) {
        remotes.push(entry.remote);
        continue;
      }
      const url = await gitRemoteUrl(entry.path, typeof entry.remote === "string" ? entry.remote : "origin");
      if (url !== null) remotes.push(url);
    }
    return {
      repos: (cfg.repos ?? []).map((entry) => entry.path),
      remotes,
      trackers,
      coAuthoredBy: cfg.operator?.coAuthoredBy ?? true,
      workers: cfg.operator?.workers === "visible" || cfg.operator?.workers === "headless" ? cfg.operator.workers : "auto",
      ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
    };
  } catch {
    return { repos: [], remotes: [], trackers: [], coAuthoredBy: true, workers: "auto" };
  }
}

export function selectWorkerRuntime(
  workers: "auto" | "visible" | "headless",
  herdrOk: boolean,
): "headless" | "visible" {
  if (workers === "headless") return "headless";
  if (workers === "visible") return herdrOk ? "visible" : "headless";
  return herdrOk ? "visible" : "headless";
}

export function createWorkerRuntime(opts: {
  workers: "auto" | "visible" | "headless";
  herdrOk: boolean;
  home: string;
  herdrCli?: HerdrCli;
  worktreeRoot?: string;
}): { executor: WorkerExecutor; provider: WorkspaceProvider } {
  const mode = selectWorkerRuntime(opts.workers, opts.herdrOk);
  if (mode === "visible" && opts.herdrCli !== undefined) {
    return {
      executor: new VisibleExecutor({ cli: opts.herdrCli, home: opts.home }),
      provider: new HerdrWorktreeProvider({
        cli: opts.herdrCli,
        home: opts.home,
        ...(opts.worktreeRoot === undefined ? {} : { worktreeRoot: opts.worktreeRoot }),
      }),
    };
  }
  return {
    executor: new HeadlessExecutor({
      sandbox: (req) => sandboxProfileForRun(req, opts.home),
    }),
    provider: new GitWorktreeProvider({
      home: opts.home,
      ...(opts.worktreeRoot === undefined ? {} : { worktreeRoot: opts.worktreeRoot }),
    }),
  };
}

function hostGhExec() {
  const bin = process.env.PI_SDLC_GH_EXEC;
  return realGhExec(typeof bin === "string" && bin.length > 0 ? bin : "gh");
}

export async function buildFactoryDeps(): Promise<FactoryDeps> {
  await ensureDirs();
  const home = factoryHome();
  const runs = runsDir();
  const root = packageRoot();
  const overlay = await readGlobalOverlay(home);
  const lanes = await loadEffectiveLanes([join(root, "src", "assets", "lanes.yaml")]);
  const agents = await loadAgentDefs({
    root,
    models: {},
    defaultModel: process.env["PI_SDLC_DEFAULT_MODEL"] ?? "slot-a",
    required: lanes.codify ? [...V1_AGENTS, "codifier"] : [...V1_AGENTS],
  });
  const tracker = new LocalAdapter(runs);
  const detected = overlay.remotes.map(detectTrackerFromRemote).find((hit) => hit !== null);
  const github: GitHubAdapterOptions | undefined = githubConfigured({
    trackers: overlay.trackers,
    remotes: overlay.remotes,
  })
    ? {
        exec: hostGhExec(),
        ...(detected === undefined ? {} : { repo: `${detected.owner}/${detected.repo}` }),
      }
    : undefined;
  const adapters = buildTrackerRegistry({
    local: tracker,
    ...(github === undefined ? {} : { github }),
    trackers: overlay.trackers,
  });
  const herdrCli = realHerdrCli();
  const herdrOk = overlay.workers === "headless" ? false : await herdrRunning(herdrCli);
  const runtime = createWorkerRuntime({
    workers: overlay.workers,
    herdrOk,
    home,
    herdrCli,
    ...(overlay.worktreeRoot === undefined ? {} : { worktreeRoot: overlay.worktreeRoot }),
  });
  const scheduler = new Scheduler({
    runsDir: runs,
    adapters,
    pollIntervalSeconds: DEFAULTS.operator.pollIntervalSeconds,
    onTicket: makeOnTicket({
      runsDir: runs,
      adapterFor: (id) => adapters.get(id),
    }),
  });
  return {
    home,
    runsDir: runs,
    projectRootDefault: root,
    engine: makeEngine(runs, { coAuthoredBy: overlay.coAuthoredBy }),
    executor: runtime.executor,
    provider: runtime.provider,
    tracker,
    adapters,
    agents,
    lanes,
    piBinary: process.env["PI_SDLC_PI_BINARY"] ?? "pi",
    repos: overlay.repos,
    scheduler,
  };
}

export async function recoverRunningRuns(runsDirPath: string): Promise<string[]> {
  return pauseRunningEngineRuns(runsDirPath);
}

export async function registerController(pi: ExtensionAPI): Promise<void> {
  const deps = await buildFactoryDeps();
  const commands = registerCommands(pi, deps);
  // resources_discover → skillPaths is a later controller task. Pi 0.84 has the
  // event; Group 1 ships skills/factory-*/SKILL.md and does not fake registration.
  let vault: Vault | null = null;
  try {
    vault = await Vault.open({ home: deps.home });
  } catch {
    vault = null;
  }
  if (vault !== null) deps.vault = vault;
  installInputGuard(pi, vault);
  pi.on("session_start", async () => {
    await recoverFactory({
      runsDir: deps.runsDir,
      ...(process.env.VITEST === undefined
        ? {
            kill: (pid: number, sig: NodeJS.Signals) => {
              try {
                process.kill(pid, sig);
              } catch {
                /* already gone */
              }
            },
          }
        : {}),
    });
    await rehydrateOpenWorkflows(deps);
    await deps.scheduler?.start();
    await commands.refresh();
  });
  pi.on("session_shutdown", async () => {
    await deps.scheduler?.stop();
  });
}
