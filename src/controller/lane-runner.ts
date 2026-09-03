import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadEffectiveConfig } from "../config/effective.js";
import type { EffectiveConfig, EffectiveRepoConfig, OperatorConfig } from "../config/schema.js";
import { Engine } from "../engine/engine.js";
import { writeEvidence } from "../engine/evidence.js";
import { loadRunState, readRunSecret, saveRunState, writeGeneratedJson } from "../engine/state.js";
import type { RunState } from "../engine/types.js";
import { Observer } from "../observer/events.js";
import { CATALOG, compileLane, BUILTIN_POLICY_PATH } from "../lanes/index.js";
import type { LaneDef, NamedLane } from "../lanes/schema.js";
import { probeSandbox, profileForRequest, type SandboxProbe, type SandboxProfile } from "../runtime/sandbox.js";
import type { DispatchCeiling } from "../codify/dispatch.js";
import type { ToolRunner } from "../codify/runner.js";
import type { AnalystPort } from "../intake/analyze.js";
import type { AgentDef, WorkerExecutor, WorkerRequest } from "../runtime/types.js";
import type { Ticket } from "../trackers/adapter.js";
import { refToString } from "../trackers/adapter.js";
import type { TrackerRegistry } from "../trackers/discovery.js";
import { LocalAdapter } from "../trackers/local.js";
import { splitGitHubId } from "../trackers/github.js";
import type { Vault } from "../vault/vault.js";
import type { PrClient } from "../git/pr.js";
import { hostGitOk } from "../git/host-git.js";
import { queueKey, readQueue, writeQueue } from "../scheduler/queue.js";
import { EnvSetupFailedError, runSetupCommand } from "../workspace/setup.js";
import { sanitizeSlug } from "../workspace/git-provider.js";
import type { Workspace, WorkspaceProvider } from "../workspace/types.js";
import { writeTicketMarkdown } from "./artifacts.js";
import { makeStageHooks, pinWorkspaceArtifacts, policyShaOf, type StageHookDeps } from "./stage-hooks.js";

export interface FactoryScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  drainOnce(): Promise<{ claimed: number; skipped: number }>;
}

export interface FactoryDeps {
  home: string;
  runsDir: string;
  projectRootDefault: string;
  engine: Engine;
  executor: WorkerExecutor;
  provider: WorkspaceProvider;
  tracker: LocalAdapter;
  adapters?: TrackerRegistry;
  agents: AgentDef[];
  lanes: Record<string, LaneDef>;
  piBinary: string;
  repos: string[];
  vault?: Vault;
  scheduler?: FactoryScheduler;
  probeSandbox?: () => Promise<SandboxProbe>;
  analyst?: AnalystPort;
  /** Injected PR client. Absent → push-only publish (v0). */
  pr?: PrClient;
  /** Process-level dispatch ceiling after `/factory start` sandbox clamp. */
  codifyDispatch?: DispatchCeiling;
  /** Doctor-style warning when exact/shadow was clamped to partial. */
  codifyStartWarning?: string;
  toolRunner?: ToolRunner;
}

export const runObservers = new Map<string, Observer>();
export const runSandboxModes = new Map<string, "required" | "best-effort" | "off">();

export async function prepareRunSandbox(
  runId: string,
  cfg: EffectiveRepoConfig,
  opts?: { probe?: () => Promise<SandboxProbe> },
): Promise<{ ok: true } | { ok: false; escalate: "env-setup-failed"; detail: string }> {
  if (cfg.sandbox === "off") {
    runSandboxModes.set(runId, "off");
    return { ok: true };
  }
  const probe = opts?.probe ?? probeSandbox;
  const result = await probe();
  if (cfg.sandbox === "required" && !result.available) {
    return { ok: false, escalate: "env-setup-failed", detail: result.detail };
  }
  runSandboxModes.set(runId, result.available ? cfg.sandbox : "off");
  return { ok: true };
}

/** HeadlessExecutor sandbox callback: wrap unless this run recorded sandbox: off. */
export function sandboxProfileForRun(req: WorkerRequest, home: string): SandboxProfile | null {
  return runSandboxModes.get(req.runId) === "off" ? null : profileForRequest(req, { home });
}

function branchTicketId(ticket: Ticket): string {
  if (ticket.ref.tracker === "github") {
    const parts = splitGitHubId(ticket.ref.id);
    if (parts !== null) return String(parts.number);
  }
  return ticket.ref.id;
}

export function renderBranch(cfg: EffectiveConfig, ticket: Ticket): string {
  const slug = sanitizeSlug(ticket.title);
  const vars: Record<string, string> = {
    tracker: ticket.ref.tracker,
    id: branchTicketId(ticket),
    slug,
    kind: ticket.kind ?? "chore",
    title: ticket.title,
    ref: refToString(ticket.ref),
  };
  let out = cfg.repo.branching.nameTemplate;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value).replaceAll(`{${key}}`, value);
  }
  return out;
}

async function workspaceOnMainCheckout(repo: string, configSha: string, remote?: string): Promise<Workspace> {
  const baseSha = await hostGitOk(["rev-parse", "HEAD"], { cwd: repo });
  const branch = await hostGitOk(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
  const gitCommon = await hostGitOk(["rev-parse", "--git-common-dir"], { cwd: repo });
  return {
    provider: "git",
    path: repo,
    branch: branch === "HEAD" ? "main" : branch,
    baseSha,
    repoRoot: repo,
    gitCommonDir: gitCommon.startsWith("/") ? gitCommon : join(repo, gitCommon),
    configSha,
    ...(remote === undefined ? {} : { remote }),
  };
}

async function stageHookDeps(deps: FactoryDeps, fusion?: OperatorConfig["fusion"]): Promise<StageHookDeps> {
  const policyBytes = await readFile(BUILTIN_POLICY_PATH);
  return {
    executor: deps.executor,
    agents: deps.agents,
    piBinary: deps.piBinary,
    projectRootDefault: deps.projectRootDefault,
    policyFile: BUILTIN_POLICY_PATH,
    policySha: policyShaOf(policyBytes),
    writeEvidence: async (dir, rec) => writeEvidence(dir, rec, await readRunSecret(dir)),
    runsDir: deps.runsDir,
    home: deps.home,
    ...(deps.vault === undefined ? {} : { vault: deps.vault }),
    ...(deps.pr == null ? {} : { pr: deps.pr }),
    ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
    ...(fusion
      ? {
          fusion: {
            off: fusion.off,
            stack: fusion.stack,
            ...(fusion.synthesizer === undefined ? {} : { synthesizer: fusion.synthesizer }),
            slotTimeoutSeconds: fusion.slotTimeoutSeconds,
          },
        }
      : {}),
  };
}

/** Recompile the lane from saved state and attach it to the in-process Engine. */
export async function attachRunWorkflow(deps: FactoryDeps, state: RunState): Promise<void> {
  const lane = deps.lanes[state.lane];
  if (lane === undefined) return;
  const named: NamedLane = { ...lane, name: state.lane };
  const cfg = await loadEffectiveConfig(state.mainCheckout, { home: deps.home });
  const workflow = compileLane(named, CATALOG, makeStageHooks(await stageHookDeps(deps, cfg.operator.fusion)));
  deps.engine.registerWorkflow(state.runId, workflow, cfg.repo);
}

const REHYDRATE_STATUSES = new Set(["waiting_user", "paused", "failed", "running"]);

export async function rehydrateOpenWorkflows(deps: FactoryDeps): Promise<string[]> {
  let entries: { name: string; isDirectory(): boolean }[] = [];
  try {
    entries = await readdir(deps.runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const attached: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "_factory") continue;
    const state = await loadRunState(deps.runsDir, entry.name);
    if (state === null || !REHYDRATE_STATUSES.has(state.status)) continue;
    await attachRunWorkflow(deps, state);
    attached.push(state.runId);
  }
  return attached;
}

async function failEnvSetup(state: RunState, runsDir: string, detail: string): Promise<RunState> {
  state.status = "failed";
  state.escalation = {
    code: "env-setup-failed",
    detail,
    at: new Date().toISOString(),
    step: state.currentStep,
  };
  await writeGeneratedJson(join(runsDir, state.runId, "escalation.json"), state.runId, state.escalation);
  await saveRunState(runsDir, state);
  return state;
}

async function bindQueueRun(deps: FactoryDeps, ticket: Ticket, state: RunState, ws: Workspace): Promise<void> {
  const queue = await readQueue(deps.runsDir);
  const gh = ticket.ref.tracker === "github" ? splitGitHubId(ticket.ref.id) : null;
  const key = gh !== null ? queueKey("github", gh.repo, String(gh.number)) : undefined;
  const entry = queue.entries.find(
    (e) =>
      (key !== undefined && e.key === key) ||
      e.ref === ticket.ref.id ||
      e.ref === refToString(ticket.ref),
  );
  if (entry === undefined) return;
  entry.runId = state.runId;
  entry.workspace = { provider: ws.provider, path: ws.path, branch: ws.branch, lane: state.lane };
  entry.baseSha = state.baseSha;
  entry.configSha = state.configSha;
  entry.updatedAt = new Date().toISOString();
  await writeQueue(deps.runsDir, queue);
}

function resolveLaneName(ticket: Ticket, lanes: Record<string, LaneDef>, requested?: string): string {
  if (requested !== undefined && requested in lanes) return requested;
  const kind = ticket.kind ?? "chore";
  const matched = Object.entries(lanes).find(([, lane]) => lane.match.kind === kind);
  if (matched) return matched[0];
  if ("chore" in lanes) return "chore";
  const first = Object.keys(lanes)[0];
  if (first === undefined) throw new Error("no lanes loaded");
  return first;
}

export async function runTicket(
  ticket: Ticket,
  repo: string,
  deps: FactoryDeps,
  opts?: { lane?: string },
): Promise<RunState> {
  const cfg = await loadEffectiveConfig(repo, { home: deps.home });
  const laneName = resolveLaneName(ticket, deps.lanes, opts?.lane);
  const lane = deps.lanes[laneName];
  if (lane === undefined) throw new Error(`unknown lane ${laneName}`);
  const named: NamedLane = { ...lane, name: laneName };
  const preBuild = (lane.class ?? "build") === "pre-build";

  const ws: Workspace = preBuild
    ? await workspaceOnMainCheckout(repo, cfg.configSha, cfg.repo.remote)
    : await deps.provider.create({
        repoRoot: repo,
        branch: renderBranch(cfg, ticket),
        base: cfg.repo.branching.base,
        slug: sanitizeSlug(refToString(ticket.ref)),
        lockReason: `factory:${refToString(ticket.ref)}`,
        remote: cfg.repo.remote,
      });

  const hooks = makeStageHooks(await stageHookDeps(deps, cfg.operator.fusion));
  const workflow = compileLane(named, CATALOG, hooks);

  const state = await deps.engine.startRun({
    workflow,
    cfg: cfg.repo,
    lane: laneName,
    kind: ticket.kind ?? "chore",
    tier: "low",
    ticket: {
      tracker: ticket.ref.tracker,
      ref: refToString(ticket.ref),
      title: ticket.title,
      ...(ticket.url === undefined ? {} : { url: ticket.url }),
    },
    workspaceDir: ws.path,
    mainCheckout: repo,
    branch: ws.branch,
    baseSha: ws.baseSha,
    cfgSha: cfg.configSha,
    budget: lane.budget,
  });

  pinWorkspaceArtifacts(state, ws);
  await saveRunState(deps.runsDir, state);
  await bindQueueRun(deps, ticket, state, ws);

  const dir = join(deps.runsDir, state.runId);
  await writeTicketMarkdown(dir, ticket.body, state.nonce);

  if (!preBuild && cfg.repo.setupCommand !== undefined && cfg.repo.setupCommand.length > 0) {
    try {
      await runSetupCommand(ws, cfg.repo, { timeoutMs: cfg.repo.setupTimeoutSeconds * 1000 });
    } catch (err) {
      const detail =
        err instanceof EnvSetupFailedError ? err.detail : err instanceof Error ? err.message : String(err);
      return failEnvSetup(state, deps.runsDir, detail);
    }
  }

  const sandbox = await prepareRunSandbox(
    state.runId,
    cfg.repo,
    deps.probeSandbox === undefined ? undefined : { probe: deps.probeSandbox },
  );
  if (!sandbox.ok) return failEnvSetup(state, deps.runsDir, sandbox.detail);

  runObservers.set(state.runId, new Observer(dir, state.runId));
  try {
    return await deps.engine.executeRun(state.runId);
  } finally {
    const obs = runObservers.get(state.runId);
    await obs?.flush();
    const latest = await deps.engine.getRun(state.runId).catch(() => state);
    if (latest.status !== "waiting_user" && latest.status !== "paused") {
      runObservers.delete(state.runId);
      runSandboxModes.delete(state.runId);
    }
  }
}
