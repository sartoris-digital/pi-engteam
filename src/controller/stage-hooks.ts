import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { StepContext, StepResult } from "../engine/types.js";
import { runChecks } from "../gate/checks.js";
import { finalize } from "../gate/finalize.js";
import { queueKey, readQueue, writeQueue } from "../commands/enqueue.js";
import { hostGit } from "../git/host-git.js";
import { publish } from "../git/publish.js";
import type { PrClient } from "../git/pr.js";
import { upsertStickyComment } from "../git/sticky.js";
import { splitGitHubId } from "../trackers/github.js";
import type { TicketRef } from "../trackers/adapter.js";
import type { TrackerRegistry } from "../trackers/discovery.js";
import type { QueueEntry, QueueFile } from "../scheduler/queue.js";
import type { StageHooks } from "../lanes/hooks.js";
import type { StageDef } from "../lanes/schema.js";
import { fusionRequestFromStage, mergeForMode, resolvePinnedModel, runFusion, type FusionSlot } from "../fusion/index.js";
import { writeStepPrompt } from "../runtime/prompt.js";
import type { AgentDef, WorkerExecutor, WorkerRequest } from "../runtime/types.js";
import { makeSteerStep, type SteerHooks } from "../steer/stage.js";
import type { RunState } from "../engine/types.js";
import type { Workspace } from "../workspace/types.js";
import { isImplementClassStage } from "../lanes/catalog.js";
import { appendHandoffLedger, isHandoffAction, type HandoffAction } from "./grill.js";
import { loadEffectiveRules } from "../rules/load.js";
import { operatorRulesBlock } from "../rules/prompt.js";
import type { RuleRecord } from "../rules/schema.js";
import { ensureGeneratedMarker } from "./artifacts.js";
import { buildStageFacts, writeStageFacts } from "./stage-facts.js";
import { isSeedWriterAgent, listScriptFiles, seedAfterWriterStage } from "../codify/seeds.js";
import { appendLedger } from "../scheduler/ledger.js";
import type { Vault } from "../vault/vault.js";

import {
  applyGateOutcomes,
  captureManifest,
  captureSnapshotBefore,
  evaluateGates,
  hasManifest,
} from "./predicates.js";

const ART_CONFIG = "workspace.configSha";
const ART_COMMON = "workspace.gitCommonDir";
const ART_REMOTE = "workspace.remote";
const ART_REMOTE_URL = "workspace.remoteUrl";

export function workspaceFromState(state: RunState): Workspace {
  const remote = state.artifacts[ART_REMOTE];
  const remoteUrl = state.artifacts[ART_REMOTE_URL];
  return {
    provider: "git",
    path: state.workspaceDir,
    branch: state.branch,
    baseSha: state.baseSha,
    repoRoot: state.mainCheckout,
    gitCommonDir: state.artifacts[ART_COMMON] ?? join(state.mainCheckout, ".git"),
    configSha: state.artifacts[ART_CONFIG] ?? state.configSha,
    ...(remote === undefined ? {} : { remote }),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  };
}

export function pinWorkspaceArtifacts(state: RunState, ws: Workspace): void {
  state.artifacts[ART_CONFIG] = ws.configSha;
  state.artifacts[ART_COMMON] = ws.gitCommonDir;
  if (ws.remote !== undefined) state.artifacts[ART_REMOTE] = ws.remote;
  if (ws.remoteUrl !== undefined) state.artifacts[ART_REMOTE_URL] = ws.remoteUrl;
}

export interface FusionHookConfig {
  off: boolean;
  stack: FusionSlot[];
  synthesizer?: string;
  slotTimeoutSeconds: number;
}

export interface StageHookDeps {
  executor: WorkerExecutor;
  agents: AgentDef[];
  piBinary: string;
  projectRootDefault: string;
  policyFile: string;
  policySha: string;
  writeEvidence: SteerHooks["writeEvidence"];
  rehash?: SteerHooks["rehash"];
  /** Injected PR client. Absent → push-only publish (v0). */
  pr?: PrClient | null;
  runsDir?: string;
  adapters?: TrackerRegistry;
  rules?: RuleRecord[];
  home?: string;
  fusion?: FusionHookConfig;
  ask?: (prompt: string) => Promise<string>;
  vault?: Vault;
}

function ticketRefFromState(state: RunState): TicketRef {
  const raw = state.ticket.ref;
  if (state.ticket.tracker === "github") {
    return { tracker: "github", id: raw.replace(/^github:/, "") };
  }
  return { tracker: state.ticket.tracker, id: raw };
}

function prRepoFromState(state: RunState): string {
  if (state.ticket.tracker !== "github") return "local";
  const id = state.ticket.ref.replace(/^github:/, "");
  return splitGitHubId(id)?.repo ?? "local";
}

function findPublishEntry(queue: QueueFile, state: RunState): QueueEntry | undefined {
  const byRun = queue.entries.find((e) => e.runId === state.runId);
  if (byRun !== undefined) return byRun;
  const id = state.ticket.ref.replace(/^github:/, "");
  const gh = state.ticket.tracker === "github" ? splitGitHubId(id) : null;
  if (gh !== null) {
    const key = queueKey("github", gh.repo, String(gh.number));
    return queue.entries.find((e) => e.key === key);
  }
  return queue.entries.find((e) => e.ref === state.ticket.ref || e.ref === id);
}

async function resolveRules(ctx: StepContext, deps: StageHookDeps): Promise<RuleRecord[]> {
  if (deps.rules !== undefined) return deps.rules;
  if (deps.home === undefined || deps.home.length === 0) return [];
  try {
    return (await loadEffectiveRules({ home: deps.home, repoPath: ctx.state.mainCheckout })).rules;
  } catch {
    return [];
  }
}

function ws(ctx: StepContext): Workspace {
  return workspaceFromState(ctx.state);
}

/** extraUpsert is the sole implementer write path; policy.yaml implementer.upsert stays empty. */
function implementerWriteRoots(ctx: StepContext): { extraUpsert: string[]; denyUpsert: string[] } {
  const extraUpsert = [...(ctx.cfg.writeRoots[ctx.state.kind] ?? [])];
  const testDir = ctx.cfg.testDir.replace(/\/+$/, "");
  const denyUpsert = [`${testDir}/**`, ...ctx.cfg.generatedDocPatterns];
  return { extraUpsert, denyUpsert };
}

function needsSnapshot(gates: string[]): boolean {
  return gates.some((g) => g === "snapshot" || g.startsWith("snapshot:"));
}

function needsManifest(gates: string[]): boolean {
  return gates.includes("manifest") || gates.includes("manifest-record");
}

async function prepareWriteBoundary(ctx: StepContext, stage: StageDef): Promise<void> {
  const gates = stage.gates ?? [];
  if (needsSnapshot(gates)) {
    try {
      await captureSnapshotBefore(ctx);
    } catch {
      /* snapshot predicate fails closed */
    }
  }
  if (isImplementClassStage(stage.name) && needsManifest(gates) && !hasManifest(ctx)) {
    try {
      await captureManifest(ctx);
    } catch {
      /* manifest predicate fails closed */
    }
  }
}

export function makeStageHooks(deps: StageHookDeps): StageHooks {
  return {
    agentStep: (def, _stage) => (ctx) => runAgent(ctx, def, deps),
    hostStep: (def, _stage) => (ctx) => runHost(ctx, def, deps),
    humanStep: (def, _stage) => (ctx) => runHuman(ctx, def, deps),
  };
}

async function runAgent(ctx: StepContext, stage: StageDef, deps: StageHookDeps): Promise<StepResult> {
  const found = deps.agents.find((a) => a.name === stage.agent);
  if (!found) throw new Error(`no agent definition for "${stage.agent ?? ""}"`);
  let agent = found;
  if (stage.model && !stage.fusion) {
    const resolved = resolvePinnedModel(stage.model, deps.fusion?.stack ?? [], found.model);
    if (resolved.degraded) {
      ctx.emit({
        ts: new Date().toISOString(),
        category: "lifecycle",
        type: "factory.fusion.degraded",
        runId: ctx.state.runId,
        step: stage.name,
        data: { requested: [stage.model], ran: [resolved.model] },
      });
    }
    agent = { ...found, model: resolved.model };
  }
  await prepareWriteBoundary(ctx, stage);
  const round = ctx.state.steps.filter((s) => s.name === stage.name).length;
  let ticket = "";
  try {
    ticket = await readFile(join(ctx.runDir, "ticket.md"), "utf8");
  } catch {
    /* optional */
  }
  const rules = await resolveRules(ctx, deps);
  const rulesBlock = operatorRulesBlock(rules, stage.name, ctx.state.kind);
  const body = [
    "## OPERATOR RULES (binding)",
    "",
    rulesBlock.length > 0 ? rulesBlock : "(none)",
    "",
    `Stage: ${stage.name}  Agent: ${agent.name}`,
    "",
    ticket.length > 0 ? ticket : "",
    "",
  ].join("\n");
  const promptPath = await writeStepPrompt(ctx.runDir, stage.name, body, round);
  try {
    await writeStageFacts(ctx.runDir, buildStageFacts({ state: ctx.state, cfg: ctx.cfg, stage: stage.name, rules }));
  } catch {
    /* facts.json is advisory: AskHost degrades gracefully without it, so a write failure never fails the stage */
  }
  const writerRoots = agent.name === "implementer" ? implementerWriteRoots(ctx) : { extraUpsert: [] as string[], denyUpsert: [] as string[] };
  const req: WorkerRequest = {
    runId: ctx.state.runId,
    runDir: ctx.runDir,
    runsDir: join(ctx.runDir, ".."),
    stage: stage.name,
    round,
    agent,
    promptPath,
    cwd: ctx.workspaceDir,
    projectRoot: ctx.state.mainCheckout || deps.projectRootDefault,
    policyFile: deps.policyFile,
    policySha: deps.policySha,
    extraUpsert: writerRoots.extraUpsert,
    denyUpsert: writerRoots.denyUpsert,
    nonce: ctx.nonce,
    timeoutMs: (stage.timeoutSeconds ?? ctx.cfg.stageTimeoutSeconds) * 1000,
    signal: ctx.signal,
    piBinary: deps.piBinary,
    tools: agent.tools,
  };
  if (stage.fusion) {
    const fusionReq = fusionRequestFromStage(stage, deps.fusion?.stack ?? []);
    if (fusionReq === null) return { verdict: "FAIL", issues: ["invalid fusion config"] };
    if (deps.fusion?.synthesizer && fusionReq.synthesizer === undefined) {
      fusionReq.synthesizer = deps.fusion.synthesizer;
    }
    return runFusion({
      req: fusionReq,
      executor: deps.executor,
      base: req,
      merge: mergeForMode(fusionReq.mode),
      slotTimeoutMs: (deps.fusion?.slotTimeoutSeconds ?? 300) * 1000,
      off: deps.fusion?.off ?? false,
      emit: ctx.emit,
    });
  }
  const worker = await deps.executor.run(req);
  const timedOut = worker.timedOut;
  const verdict = worker.verdict;
  if (verdict === null || timedOut) {
    const issues = [timedOut ? "worker timed out" : "no verdict"];
    if (worker.stderrTail.trim().length > 0) issues.push(worker.stderrTail.trim());
    if (worker.exitCode !== null) issues.push(`exit ${worker.exitCode}`);
    return { verdict: "FAIL", issues, evidence: { timedOut } };
  }
  for (const rel of verdict.artifacts ?? []) {
    const abs = isAbsolute(rel) ? rel : join(ctx.runDir, rel);
    await ensureGeneratedMarker(abs, ctx.state.runId);
  }
  const result: StepResult = {
    verdict: verdict.verdict,
    issues: verdict.issues,
    evidence: { timedOut: false, artifacts: (verdict.artifacts ?? []).map((path) => ({ path, sha256: "" })) },
  };
  if (stage.name === "gate" && !hasManifest(ctx)) {
    try {
      await captureManifest(ctx);
    } catch {
      /* manifest-record predicate fails closed */
    }
  }
  applyGateOutcomes(result, await evaluateGates(ctx, stage.gates ?? [], result));
  const status = await hostGit(["status", "--porcelain"], { cwd: ctx.workspaceDir });
  if (status.stdout.trim().length > 0) {
    result.commit = {
      message: verdict.commit_message ?? `${stage.name}: checkpoint (${ctx.state.ticket.ref})`,
    };
  }
  if (result.verdict === "PASS" && isSeedWriterAgent(agent.name)) {
    const runsDir = deps.runsDir ?? join(ctx.runDir, "..");
    try {
      const declared = verdict.scripts ?? [];
      const createdFiles = [
        ...new Set([
          ...(verdict.changedFiles ?? []),
          ...declared.map((s) => s.path),
          ...(await listScriptFiles(join(ctx.runDir, "scripts"), "scripts")),
          ...(await listScriptFiles(join(ctx.workspaceDir, "scripts"), "scripts")),
        ]),
      ];
      await seedAfterWriterStage({
        runsDir,
        runId: ctx.state.runId,
        stage: stage.name,
        workspaceDir: ctx.workspaceDir,
        runDir: ctx.runDir,
        writeRoots: ctx.cfg.writeRoots[ctx.state.kind] ?? [],
        createdFiles,
        commands: result.evidence?.commands ?? [],
        declared,
        taskContext: ticket,
        ...(deps.vault === undefined ? {} : { vault: deps.vault }),
      });
    } catch (err) {
      try {
        await appendLedger(runsDir, {
          ts: new Date().toISOString(),
          type: "codify.seed",
          code: "seed-failed",
          key: ctx.state.runId,
        });
      } catch {
        /* seed-failed ledger is best-effort */
      }
      void err;
    }
  }
  return result;
}

async function runHost(ctx: StepContext, stage: StageDef, deps: StageHookDeps): Promise<StepResult> {
  if (stage.host === "scope-check") return scopeCheck(ctx);
  if (stage.host === "checks") return runTestChecks(ctx, stage);
  if (stage.host === "publish") return runPublish(ctx, stage, deps);
  if (stage.host === "escalate") {
    return { verdict: "FAIL", issues: ctx.state.escalation?.detail ? [ctx.state.escalation.detail] : ["escalated"] };
  }
  return { verdict: "FAIL", issues: [`unknown host action ${stage.host}`], escalate: "needs-decision" };
}

async function scopeCheck(ctx: StepContext): Promise<StepResult> {
  let text = "";
  for (const name of ["ticket.md", "task.md"]) {
    try {
      text += await readFile(join(ctx.runDir, name), "utf8");
    } catch {
      /* optional */
    }
  }
  const needles = [...ctx.cfg.riskPaths, ...ctx.cfg.exclusivePaths, "lockfile", "manifest", "migrations", "CI"];
  if (needles.some((n) => n.length > 0 && text.toLowerCase().includes(n.toLowerCase()))) {
    ctx.state.tier = "elevated";
  }
  return {
    verdict: "PASS",
    evidence: { predicates: [{ name: "scope-report", ok: true, note: `tier=${ctx.state.tier}` }] },
  };
}

async function runTestChecks(ctx: StepContext, stage: StageDef): Promise<StepResult> {
  const workspace = ws(ctx);
  if (ctx.cfg.testInfra.length > 0) {
    await hostGit(["checkout", ctx.state.baseSha, "--", ...ctx.cfg.testInfra], { cwd: ctx.workspaceDir });
  }
  const results = await runChecks(workspace, ctx.cfg.checks, {
    timeoutMs: ctx.cfg.checksTimeoutSeconds * 1000,
    concurrency: ctx.cfg.checksConcurrency,
    rerunFailedOnce: true,
  });
  const fin = await finalize({
    ws: workspace,
    baseSha: ctx.state.baseSha,
    writeRoots: ctx.cfg.writeRoots[ctx.state.kind] ?? [],
    maxDiffLines: ctx.cfg.maxDiffLines,
    maxChangedFiles: ctx.cfg.maxChangedFiles,
    generatedDocPatterns: ctx.cfg.generatedDocPatterns,
  });
  const stepResult: StepResult = {
    verdict: results.every((r) => r.exitCode === 0 && !r.timedOut) && fin.ok ? "PASS" : "FAIL",
    evidence: {
      commands: results.map((r) => ({
        argv: r.argv,
        exitCode: r.exitCode ?? 1,
        durationMs: r.durationMs,
        outputTail: r.outputTail,
      })),
      predicates: [],
    },
  };
  if (!fin.ok && fin.violations.some((v) => v.code === "too-large")) {
    stepResult.escalate = "too-large";
  }
  const extra = ["junit-green", "checks-green"].filter((g) => !(stage.gates ?? []).includes(g));
  applyGateOutcomes(stepResult, await evaluateGates(ctx, [...(stage.gates ?? []), ...extra], stepResult));
  if (!fin.ok && fin.violations.some((v) => v.code === "scope-violation" || v.code === "generated-doc")) {
    stepResult.verdict = "FAIL";
  }
  return stepResult;
}

async function runPublish(ctx: StepContext, stage: StageDef, deps: StageHookDeps): Promise<StepResult> {
  const published: StepResult = { verdict: "PASS" };
  const gates = await evaluateGates(ctx, stage.gates ?? [], published);
  applyGateOutcomes(published, gates);
  if (published.verdict !== "PASS") {
    return {
      verdict: "FAIL",
      issues: gates.filter((g) => !g.ok).map((g) => `${g.name}: ${g.note ?? "failed"}`),
      escalate: published.escalate ?? "publish-refused",
      evidence: published.evidence,
    };
  }
  const result = await publish(ctx.state, ctx.cfg, ws(ctx), {
    ...(deps.pr == null
      ? {}
      : { pr: deps.pr, runDir: ctx.runDir, prRepo: prRepoFromState(ctx.state) }),
  });
  if (!result.pushed) {
    return {
      verdict: "FAIL",
      issues: [result.detail],
      escalate: result.code === "push-rejected" ? "push-rejected" : "publish-refused",
      evidence: published.evidence,
    };
  }
  if (deps.runsDir !== undefined) {
    const queue = await readQueue(deps.runsDir);
    const entry = findPublishEntry(queue, ctx.state);
    if (entry !== undefined) {
      entry.state = "published";
      entry.updatedAt = new Date().toISOString();
      entry.judgedSha = result.sha;
      entry.hostCommits = [...ctx.state.hostCommits];
      if (result.pr !== undefined) {
        entry.prUrl = result.pr.url;
        entry.prNumber = result.pr.number;
      }
      const adapter = deps.adapters?.get(ctx.state.ticket.tracker);
      if (adapter !== undefined) {
        await upsertStickyComment({
          adapter,
          ref: ticketRefFromState(ctx.state),
          runId: ctx.state.runId,
          body: result.pr !== undefined ? `published ${result.pr.url}` : `published ${result.sha}`,
          milestone: "publish",
          entry,
        });
      }
      await writeQueue(deps.runsDir, queue);
    }
  }
  ctx.emit({
    category: "lifecycle",
    type: "run.published",
    runId: ctx.state.runId,
    ts: new Date().toISOString(),
    step: "publish",
    data: { sha: result.sha, branch: result.branch, ...(result.pr === undefined ? {} : { prUrl: result.pr.url }) },
  });
  return { verdict: "PASS", evidence: published.evidence };
}

async function runHuman(ctx: StepContext, stage: StageDef, deps: StageHookDeps): Promise<StepResult> {
  if (stage.name === "handoff" || stage.packet === "handoff") {
    return runHandoff(ctx, deps);
  }
  if (stage.name !== "steer") {
    return { verdict: "FAIL", escalate: "needs-decision", issues: [`unknown human stage ${stage.name}`] };
  }
  const step = makeSteerStep((c) => c.cfg.steering, {
    writeEvidence: deps.writeEvidence,
    rehash: deps.rehash ?? (async () => ({ ok: true, note: "v0: no gate stage" })),
  });
  return step.run(ctx);
}

async function runHandoff(ctx: StepContext, deps: StageHookDeps): Promise<StepResult> {
  const packetPath = join(ctx.runDir, "handoff.md");
  const recorded = ctx.state.artifacts["handoff-action"] ?? "";
  let action: HandoffAction | undefined = isHandoffAction(recorded) ? recorded : undefined;
  if (action === undefined && deps.ask !== undefined) {
    const raw = (await deps.ask("handoff: enqueue | file-ticket | save | another-round | drop")).trim();
    if (isHandoffAction(raw)) action = raw;
  }
  if (action === undefined) {
    return {
      verdict: "PASS",
      artifacts: { handoff: packetPath },
      pauseForUser: { reason: "handoff", packetPath },
    };
  }
  ctx.state.artifacts["handoff-action"] = action;
  const runsDir = deps.runsDir ?? join(ctx.runDir, "..");
  await appendHandoffLedger(runsDir, {
    type: "grill.handoff",
    runId: ctx.state.runId,
    action,
    ts: new Date().toISOString(),
  });
  if (action === "drop") {
    return { verdict: "FAIL", issues: ["dropped at grill handoff"], escalate: "needs-decision", artifacts: { handoff: packetPath } };
  }
  if (action === "another-round") {
    return { verdict: "NEEDS_MORE", issues: ["another-round"], artifacts: { handoff: packetPath } };
  }
  return { verdict: "PASS", artifacts: { handoff: packetPath } };
}

export function policyShaOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
