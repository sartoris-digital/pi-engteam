import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../commands/index.js";
import { Engine } from "../engine/engine.js";
import { loadRunState, saveRunState } from "../engine/state.js";
import { checkpointCommit } from "../git/checkpoint.js";
import { ensureDirs, factoryHome, runsDir } from "../home.js";
import { evalWhen as evalLaneExpr, type WhenContext } from "../lanes/expr.js";
import { loadEffectiveLanes } from "../lanes/index.js";
import type { FactoryEvent } from "../observer/events.js";
import { HeadlessExecutor } from "../runtime/headless.js";
import { profileForRequest } from "../runtime/sandbox.js";
import { LocalAdapter } from "../trackers/local.js";
import { GitWorktreeProvider } from "../workspace/git-provider.js";
import { loadAgentDefs, packageRoot } from "./agents.js";
import { readJsonArtifact } from "./artifacts.js";
import { rehydrateOpenWorkflows, runObservers, runSandboxModes, type FactoryDeps } from "./lane-runner.js";
import { workspaceFromState } from "./stage-hooks.js";

const CHORE_LANE_AGENTS = ["planner", "implementer", "reviewer", "judge"] as const;
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
    verify: async () => ({ verdict: "PASS" as const }),
  });
}

interface GlobalOverlay {
  repos: string[];
  coAuthoredBy: boolean;
  worktreeRoot?: string;
}

async function readGlobalOverlay(home: string): Promise<GlobalOverlay> {
  try {
    const cfg = await readJsonArtifact<{
      operator?: { coAuthoredBy?: boolean; worktreeRoot?: string };
      repos?: { path: string }[];
    }>(join(home, "factory.json"));
    const worktreeRoot = cfg.operator?.worktreeRoot;
    return {
      repos: (cfg.repos ?? []).map((entry) => entry.path),
      coAuthoredBy: cfg.operator?.coAuthoredBy ?? true,
      ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
    };
  } catch {
    return { repos: [], coAuthoredBy: true };
  }
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
    required: [...CHORE_LANE_AGENTS],
  });
  return {
    home,
    runsDir: runs,
    projectRootDefault: root,
    engine: makeEngine(runs, { coAuthoredBy: overlay.coAuthoredBy }),
    executor: new HeadlessExecutor({
      sandbox: (req) =>
        runSandboxModes.get(req.runId) === "off" ? null : profileForRequest(req, { home }),
    }),
    provider: new GitWorktreeProvider({
      home,
      ...(overlay.worktreeRoot === undefined ? {} : { worktreeRoot: overlay.worktreeRoot }),
    }),
    tracker: new LocalAdapter(runs),
    agents,
    lanes,
    piBinary: process.env["PI_SDLC_PI_BINARY"] ?? "pi",
    repos: overlay.repos,
  };
}

export async function recoverRunningRuns(runsDirPath: string): Promise<string[]> {
  let entries: { name: string; isDirectory(): boolean }[] = [];
  try {
    entries = await readdir(runsDirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const recovered: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "_factory") continue;
    const state = await loadRunState(runsDirPath, entry.name);
    if (state === null || state.status !== "running") continue;
    state.status = "paused";
    state.updatedAt = new Date().toISOString();
    await saveRunState(runsDirPath, state);
    recovered.push(entry.name);
  }
  return recovered;
}

export async function registerController(pi: ExtensionAPI): Promise<void> {
  const deps = await buildFactoryDeps();
  const commands = registerCommands(pi, deps);
  pi.on("session_start", async () => {
    await recoverRunningRuns(deps.runsDir);
    await rehydrateOpenWorkflows(deps);
    await commands.refresh();
  });
}
