import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepContext, StepResult } from "../engine/types.js";
import { changedFilesSince } from "../gate/finalize.js";
import { findGeneratedDocs } from "../gate/generated-docs.js";
import { parseJunit } from "../gate/junit.js";
import { hostGit } from "../git/host-git.js";
import { listEvidence, verifyEvidence } from "../engine/evidence.js";
import { readRunSecret } from "../engine/state.js";
import type { Workspace } from "../workspace/types.js";

export interface PredicateResult {
  name: string;
  ok: boolean;
  note?: string;
}

function workspaceOf(ctx: StepContext): Workspace {
  return {
    provider: "git",
    path: ctx.workspaceDir,
    branch: ctx.state.branch,
    baseSha: ctx.state.baseSha,
    repoRoot: ctx.state.mainCheckout,
    gitCommonDir: join(ctx.state.mainCheckout, ".git"),
    configSha: ctx.state.configSha,
  };
}

async function junitGreen(ctx: StepContext): Promise<PredicateResult> {
  const rel = ctx.cfg.checks[0]?.junitPath;
  if (rel === undefined || rel.length === 0) {
    return { name: "junit-green", ok: false, note: "no junitPath on checks[0]" };
  }
  const path = join(ctx.workspaceDir, rel);
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch {
    return { name: "junit-green", ok: false, note: `missing ${rel}` };
  }
  try {
    const report = parseJunit(xml);
    const ok = report.counts.failed === 0 && report.counts.error === 0;
    return { name: "junit-green", ok, note: ok ? undefined : `failures=${report.counts.failed} errors=${report.counts.error}` };
  } catch (err) {
    return { name: "junit-green", ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

async function checksGreen(result: StepResult): Promise<PredicateResult> {
  const commands = result.evidence?.commands ?? [];
  const ok = commands.length > 0 && commands.every((c) => c.exitCode === 0 && !result.evidence?.timedOut);
  return { name: "checks-green", ok, note: ok ? undefined : "a check exited non-zero or timed out" };
}

async function noGeneratedDocs(ctx: StepContext): Promise<PredicateResult> {
  const ws = workspaceOf(ctx);
  let changed: string[] = [];
  try {
    changed = await changedFilesSince(ws, ctx.state.baseSha);
  } catch {
    changed = [];
  }
  const found = await findGeneratedDocs(ws, changed, ctx.cfg.generatedDocPatterns);
  return {
    name: "no-generated-docs",
    ok: found.length === 0,
    note: found.length === 0 ? undefined : found.join(", "),
  };
}

async function headIsJudgedSha(ctx: StepContext): Promise<PredicateResult> {
  if (ctx.state.judgedSha === undefined) {
    return { name: "head-is-judged-sha", ok: false, note: "no judgedSha" };
  }
  const head = await hostGit(["rev-parse", "HEAD"], { cwd: ctx.workspaceDir });
  const sha = head.stdout.trim();
  const ok = head.code === 0 && sha === ctx.state.judgedSha;
  return { name: "head-is-judged-sha", ok, note: ok ? undefined : `HEAD ${sha} != judgedSha ${ctx.state.judgedSha}` };
}

async function evidenceSigned(ctx: StepContext): Promise<PredicateResult> {
  const listed = await listEvidence(ctx.runDir);
  const last = listed[listed.length - 1];
  if (last === undefined) return { name: "evidence-signed", ok: false, note: "no evidence records" };
  try {
    const secret = await readRunSecret(ctx.runDir);
    const verified = await verifyEvidence(ctx.runDir, last.stage, last.round, secret);
    return { name: "evidence-signed", ok: verified.ok, note: verified.reason };
  } catch (err) {
    return { name: "evidence-signed", ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

async function sectionsGate(ctx: StepContext, spec: string): Promise<PredicateResult> {
  const colon = spec.indexOf(":");
  const file = colon < 0 ? spec : spec.slice(0, colon);
  const headings = (colon < 0 ? "" : spec.slice(colon + 1))
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  let text: string;
  try {
    text = await readFile(join(ctx.runDir, file), "utf8");
  } catch {
    return { name: `sections:${spec}`, ok: false, note: `missing ${file}` };
  }
  const missing = headings.filter((heading) => {
    const re = new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
    return !re.test(text);
  });
  return {
    name: `sections:${spec}`,
    ok: missing.length === 0,
    note: missing.length === 0 ? undefined : `missing ${missing.join(", ")}`,
  };
}

export async function evaluateGates(
  ctx: StepContext,
  gates: string[],
  result: StepResult,
): Promise<PredicateResult[]> {
  const out: PredicateResult[] = [];
  for (const gate of gates) {
    if (gate === "junit-green") {
      out.push(await junitGreen(ctx));
      continue;
    }
    if (gate === "checks-green") {
      out.push(await checksGreen(result));
      continue;
    }
    if (gate === "no-generated-docs") {
      out.push(await noGeneratedDocs(ctx));
      continue;
    }
    if (gate === "head-is-judged-sha") {
      out.push(await headIsJudgedSha(ctx));
      continue;
    }
    if (gate === "evidence-signed") {
      out.push(await evidenceSigned(ctx));
      continue;
    }
    if (gate.startsWith("sections:")) {
      out.push(await sectionsGate(ctx, gate.slice("sections:".length)));
      continue;
    }
    out.push({ name: gate, ok: true, note: "v0: not enforced" });
  }
  return out;
}

export function allGatesOk(results: PredicateResult[]): boolean {
  return results.every((r) => r.ok);
}
