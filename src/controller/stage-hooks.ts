import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { StepContext, StepResult } from "../engine/types.js";
import { runChecks } from "../gate/checks.js";
import { finalize } from "../gate/finalize.js";
import { hostGit } from "../git/host-git.js";
import { publish } from "../git/publish.js";
import type { StageHooks } from "../lanes/hooks.js";
import type { StageDef } from "../lanes/schema.js";
import { writeStepPrompt } from "../runtime/prompt.js";
import type { AgentDef, WorkerExecutor, WorkerRequest } from "../runtime/types.js";
import { makeSteerStep, type SteerHooks } from "../steer/stage.js";
import type { RunState } from "../engine/types.js";
import type { Workspace } from "../workspace/types.js";
import { ensureGeneratedMarker } from "./artifacts.js";
import { allGatesOk, evaluateGates } from "./predicates.js";

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

export interface StageHookDeps {
  executor: WorkerExecutor;
  agents: AgentDef[];
  piBinary: string;
  projectRootDefault: string;
  policyFile: string;
  policySha: string;
  writeEvidence: SteerHooks["writeEvidence"];
  rehash?: SteerHooks["rehash"];
}

function ws(ctx: StepContext): Workspace {
  return workspaceFromState(ctx.state);
}

export function makeStageHooks(deps: StageHookDeps): StageHooks {
  return {
    agentStep: (def, _stage) => (ctx) => runAgent(ctx, def, deps),
    hostStep: (def, _stage) => (ctx) => runHost(ctx, def, deps),
    humanStep: (def, _stage) => (ctx) => runHuman(ctx, def, deps),
  };
}

async function runAgent(ctx: StepContext, stage: StageDef, deps: StageHookDeps): Promise<StepResult> {
  const agent = deps.agents.find((a) => a.name === stage.agent);
  if (!agent) throw new Error(`no agent definition for "${stage.agent ?? ""}"`);
  const round = ctx.state.steps.filter((s) => s.name === stage.name).length;
  let ticket = "";
  try {
    ticket = await readFile(join(ctx.runDir, "ticket.md"), "utf8");
  } catch {
    /* optional */
  }
  const body = [
    "## OPERATOR RULES (binding)",
    "",
    "(none in v0)",
    "",
    `Stage: ${stage.name}  Agent: ${agent.name}`,
    "",
    ticket.length > 0 ? ticket : "",
    "",
  ].join("\n");
  const promptPath = await writeStepPrompt(ctx.runDir, stage.name, body, round);
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
    extraUpsert: [],
    denyUpsert: [],
    nonce: ctx.nonce,
    timeoutMs: (stage.timeoutSeconds ?? ctx.cfg.stageTimeoutSeconds) * 1000,
    signal: ctx.signal,
    piBinary: deps.piBinary,
  };
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
  const gates = await evaluateGates(ctx, stage.gates ?? [], result);
  result.evidence = { ...result.evidence, predicates: gates };
  if (!allGatesOk(gates) && result.verdict === "PASS") result.verdict = "FAIL";
  const status = await hostGit(["status", "--porcelain"], { cwd: ctx.workspaceDir });
  if (status.stdout.trim().length > 0) {
    result.commit = {
      message: verdict.commit_message ?? `${stage.name}: checkpoint (${ctx.state.ticket.ref})`,
    };
  }
  return result;
}

async function runHost(ctx: StepContext, stage: StageDef, _deps: StageHookDeps): Promise<StepResult> {
  if (stage.host === "scope-check") return scopeCheck(ctx);
  if (stage.host === "checks") return runTestChecks(ctx, stage);
  if (stage.host === "publish") return runPublish(ctx);
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
  const gates = await evaluateGates(ctx, [...(stage.gates ?? []), ...extra], stepResult);
  stepResult.evidence = { ...stepResult.evidence, predicates: gates };
  if (!allGatesOk(gates)) stepResult.verdict = "FAIL";
  if (!fin.ok && fin.violations.some((v) => v.code === "scope-violation" || v.code === "generated-doc")) {
    stepResult.verdict = "FAIL";
  }
  return stepResult;
}

async function runPublish(ctx: StepContext): Promise<StepResult> {
  const result = await publish(ctx.state, ctx.cfg, ws(ctx));
  if (!result.pushed) {
    return {
      verdict: "FAIL",
      issues: [result.detail],
      escalate: result.code === "push-rejected" ? "push-rejected" : "publish-refused",
    };
  }
  ctx.emit({
    category: "lifecycle",
    type: "run.published",
    runId: ctx.state.runId,
    ts: new Date().toISOString(),
    step: "publish",
    data: { sha: result.sha, branch: result.branch },
  });
  return { verdict: "PASS", evidence: { predicates: [{ name: "head-is-judged-sha", ok: true }] } };
}

async function runHuman(ctx: StepContext, stage: StageDef, deps: StageHookDeps): Promise<StepResult> {
  if (stage.name !== "steer") {
    return { verdict: "FAIL", escalate: "needs-decision", issues: [`unknown human stage ${stage.name}`] };
  }
  const step = makeSteerStep((c) => c.cfg.steering, {
    writeEvidence: deps.writeEvidence,
    rehash: deps.rehash ?? (async () => ({ ok: true, note: "v0: no gate stage" })),
  });
  return step.run(ctx);
}

export function policyShaOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
