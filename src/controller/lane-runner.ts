import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEffectiveConfig } from "../config/effective.js";
import type { EffectiveConfig, EffectiveRepoConfig } from "../config/schema.js";
import { Engine } from "../engine/engine.js";
import { writeEvidence } from "../engine/evidence.js";
import { readRunSecret, saveRunState, writeGeneratedJson } from "../engine/state.js";
import type { RunState } from "../engine/types.js";
import { Observer } from "../observer/events.js";
import { CATALOG, compileLane, BUILTIN_POLICY_PATH } from "../lanes/index.js";
import type { LaneDef, NamedLane } from "../lanes/schema.js";
import { probeSandbox, type SandboxProbe } from "../runtime/sandbox.js";
import type { AgentDef, WorkerExecutor } from "../runtime/types.js";
import type { Ticket } from "../trackers/adapter.js";
import { refToString } from "../trackers/adapter.js";
import { LocalAdapter } from "../trackers/local.js";
import { runSetupCommand } from "../workspace/setup.js";
import { sanitizeSlug } from "../workspace/git-provider.js";
import type { WorkspaceProvider } from "../workspace/types.js";
import { writeTicketMarkdown } from "./artifacts.js";
import { makeStageHooks, pinWorkspaceArtifacts, policyShaOf } from "./stage-hooks.js";

export interface FactoryDeps {
  home: string;
  runsDir: string;
  projectRootDefault: string;
  engine: Engine;
  executor: WorkerExecutor;
  provider: WorkspaceProvider;
  tracker: LocalAdapter;
  agents: AgentDef[];
  lanes: Record<string, LaneDef>;
  piBinary: string;
  repos: string[];
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

export function renderBranch(cfg: EffectiveConfig, ticket: Ticket): string {
  const slug = sanitizeSlug(ticket.title);
  const vars: Record<string, string> = {
    tracker: ticket.ref.tracker,
    id: ticket.ref.id,
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

  const ws = await deps.provider.create({
    repoRoot: repo,
    branch: renderBranch(cfg, ticket),
    base: cfg.repo.branching.base,
    slug: sanitizeSlug(refToString(ticket.ref)),
    lockReason: `factory:${refToString(ticket.ref)}`,
    remote: cfg.repo.remote,
  });

  if (cfg.repo.setupCommand !== undefined && cfg.repo.setupCommand.length > 0) {
    await runSetupCommand(ws, cfg.repo, { timeoutMs: cfg.repo.setupTimeoutSeconds * 1000 });
  }

  const policyBytes = await readFile(BUILTIN_POLICY_PATH);
  const hooks = makeStageHooks({
    executor: deps.executor,
    agents: deps.agents,
    piBinary: deps.piBinary,
    projectRootDefault: deps.projectRootDefault,
    policyFile: BUILTIN_POLICY_PATH,
    policySha: policyShaOf(policyBytes),
    writeEvidence: async (dir, rec) => writeEvidence(dir, rec, await readRunSecret(dir)),
  });
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

  const dir = join(deps.runsDir, state.runId);
  await writeTicketMarkdown(dir, ticket.body, state.nonce);

  const sandbox = await prepareRunSandbox(state.runId, cfg.repo);
  if (!sandbox.ok) {
    state.status = "failed";
    state.escalation = {
      code: "env-setup-failed",
      detail: sandbox.detail,
      at: new Date().toISOString(),
      step: state.currentStep,
    };
    await writeGeneratedJson(join(dir, "escalation.json"), state.runId, state.escalation);
    await saveRunState(deps.runsDir, state);
    return state;
  }

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
