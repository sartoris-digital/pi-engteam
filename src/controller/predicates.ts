import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EscalationCode, StepContext, StepResult } from "../engine/types.js";
import { listEvidence, readEvidence, verifyEvidence } from "../engine/evidence.js";
import { readGeneratedJson, readRunSecret, writeGeneratedJson } from "../engine/state.js";
import { changedFilesSince, finalize } from "../gate/finalize.js";
import { findGeneratedDocs } from "../gate/generated-docs.js";
import { matchesAny } from "../gate/glob.js";
import { parseJunit } from "../gate/junit.js";
import { recordManifest, verifyManifestUnchanged, type Manifest } from "../gate/manifest.js";
import { verifyRedBaseline } from "../gate/red.js";
import { diffOutsideRoots, listWorkingTree, snapshotTree, type Snapshot } from "../gate/snapshot.js";
import { hostGit } from "../git/host-git.js";
import { publishPreflight } from "../git/preflight.js";
import { isPredicate, parsePredicate } from "../lanes/catalog.js";
import type { Workspace } from "../workspace/types.js";

const ART_CONFIG = "workspace.configSha";
const ART_COMMON = "workspace.gitCommonDir";
const ART_REMOTE = "workspace.remote";
const ART_REMOTE_URL = "workspace.remoteUrl";

export const ART_SNAPSHOT_BEFORE = "snapshot.before";
export const ART_MANIFEST = "manifest.json";
export const ART_GATE_TEST_IDS = "gate.testIds";
export const ART_DEPS_APPROVAL = "dependency-approval.json";

const SNAPSHOT_FILE = "snapshot-before.json";
const MANIFEST_FILE = "manifest.json";
const PATH_LINE_RE = /(?:^|[\s`'(["])([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)\b/;
const JUNIT_ID_RE = /\S+::\S+/;
const AC_LINE_RE = /^AC(\d+):\s*(.*)$/gim;

export interface PredicateResult {
  name: string;
  ok: boolean;
  note?: string;
  escalate?: EscalationCode;
}

function workspaceOf(ctx: StepContext): Workspace {
  const remote = ctx.state.artifacts[ART_REMOTE];
  const remoteUrl = ctx.state.artifacts[ART_REMOTE_URL];
  return {
    provider: "git",
    path: ctx.workspaceDir,
    branch: ctx.state.branch,
    baseSha: ctx.state.baseSha,
    repoRoot: ctx.state.mainCheckout,
    gitCommonDir: ctx.state.artifacts[ART_COMMON] ?? join(ctx.state.mainCheckout, ".git"),
    configSha: ctx.state.artifacts[ART_CONFIG] ?? ctx.state.configSha,
    ...(remote === undefined ? {} : { remote }),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function loadJsonArtifact<T>(ctx: StepContext, key: string, fallbackRel?: string): Promise<T | null> {
  const raw = ctx.state.artifacts[key];
  if (raw !== undefined && raw.length > 0) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        /* fall through to path / file */
      }
    }
    const fromGenerated = await readGeneratedJson<T>(trimmed);
    if (fromGenerated !== null) return fromGenerated;
    try {
      return JSON.parse(await readFile(trimmed, "utf8")) as T;
    } catch {
      /* try fallback */
    }
  }
  if (fallbackRel === undefined) return null;
  const fallbackPath = join(ctx.runDir, fallbackRel);
  const generated = await readGeneratedJson<T>(fallbackPath);
  if (generated !== null) return generated;
  try {
    return JSON.parse(await readFile(fallbackPath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function persistJsonArtifact(ctx: StepContext, key: string, rel: string, value: unknown): Promise<string> {
  const path = join(ctx.runDir, rel);
  await writeGeneratedJson(path, ctx.state.runId, value);
  ctx.state.artifacts[key] = path;
  return path;
}

export async function captureSnapshotBefore(ctx: StepContext): Promise<void> {
  const snap = await snapshotTree(workspaceOf(ctx));
  await persistJsonArtifact(ctx, ART_SNAPSHOT_BEFORE, SNAPSHOT_FILE, snap);
}

export async function captureManifest(ctx: StepContext): Promise<void> {
  const manifest = await recordManifest(workspaceOf(ctx), ctx.cfg.testDir, ctx.cfg.testInfra);
  await persistJsonArtifact(ctx, ART_MANIFEST, MANIFEST_FILE, manifest);
}

export function hasSnapshotBefore(ctx: StepContext): boolean {
  return (ctx.state.artifacts[ART_SNAPSHOT_BEFORE] ?? "").length > 0;
}

export function hasManifest(ctx: StepContext): boolean {
  return (ctx.state.artifacts[ART_MANIFEST] ?? "").length > 0;
}

function evidenceRow(r: PredicateResult): { name: string; ok: boolean; note?: string } {
  return r.note === undefined ? { name: r.name, ok: r.ok } : { name: r.name, ok: r.ok, note: r.note };
}

export function applyGateOutcomes(result: StepResult, gates: PredicateResult[]): StepResult {
  result.evidence = { ...result.evidence, predicates: gates.map(evidenceRow) };
  if (!allGatesOk(gates)) {
    if (result.verdict === "PASS") result.verdict = "FAIL";
    const failed = gates.filter((g) => !g.ok);
    const esc = failed.find((g) => g.escalate)?.escalate;
    if (esc !== undefined && result.escalate === undefined) result.escalate = esc;
  }
  return result;
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
  if (listed.length === 0) return { name: "evidence-signed", ok: false, note: "no evidence records" };
  try {
    const secret = await readRunSecret(ctx.runDir);
    const failed: string[] = [];
    for (const rec of listed) {
      const verified = await verifyEvidence(ctx.runDir, rec.stage, rec.round, secret);
      if (!verified.ok) failed.push(`${rec.stage}-r${rec.round}${verified.reason ? `: ${verified.reason}` : ""}`);
    }
    return {
      name: "evidence-signed",
      ok: failed.length === 0,
      note: failed.length === 0 ? undefined : failed.join("; "),
    };
  } catch (err) {
    return { name: "evidence-signed", ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

async function noSynthesized(ctx: StepContext): Promise<PredicateResult> {
  const listed = await listEvidence(ctx.runDir);
  const hits: string[] = [];
  for (const rec of listed) {
    const ev = await readEvidence(ctx.runDir, rec.stage, rec.round);
    if ((ev?.synthesized ?? []).length > 0) hits.push(`${rec.stage}-r${rec.round}`);
  }
  return {
    name: "no-synthesized",
    ok: hits.length === 0,
    note: hits.length === 0 ? undefined : `synthesized in ${hits.join(", ")}`,
  };
}

async function preflightGate(ctx: StepContext): Promise<PredicateResult> {
  try {
    const pre = await publishPreflight(ctx.state, ctx.cfg, workspaceOf(ctx));
    return { name: "preflight", ok: pre.ok, note: pre.ok ? undefined : `${pre.code}: ${pre.detail}` };
  } catch (err) {
    return { name: "preflight", ok: false, note: err instanceof Error ? err.message : String(err) };
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

async function readJunitReport(ctx: StepContext): Promise<{ xml?: string; rel?: string; error?: string }> {
  const rel = ctx.cfg.checks[0]?.junitPath;
  if (rel === undefined || rel.length === 0) return { error: "no junitPath on checks[0]" };
  try {
    return { rel, xml: await readFile(join(ctx.workspaceDir, rel), "utf8") };
  } catch {
    return { rel, error: `missing ${rel}` };
  }
}

async function gateTestIds(ctx: StepContext): Promise<string[]> {
  const fromArt = await loadJsonArtifact<unknown>(ctx, ART_GATE_TEST_IDS, "gate.testIds.json");
  if (Array.isArray(fromArt)) return fromArt.filter((id): id is string => typeof id === "string");
  const listed = await listEvidence(ctx.runDir);
  for (const rec of [...listed].reverse()) {
    const ev = await readEvidence(ctx.runDir, rec.stage, rec.round);
    if (!ev) continue;
    for (const art of ev.artifacts) {
      if (!/testIds|gate\.testIds/i.test(art.path)) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(art.path, "utf8"));
        if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === "string");
      } catch {
        /* keep looking */
      }
    }
  }
  return [];
}

async function redBaseline(ctx: StepContext): Promise<PredicateResult> {
  const junit = await readJunitReport(ctx);
  if (junit.xml === undefined) {
    return { name: "red-baseline", ok: false, note: junit.error ?? "missing junit", escalate: "gate-invalid" };
  }
  let report;
  try {
    report = parseJunit(junit.xml);
  } catch (err) {
    return {
      name: "red-baseline",
      ok: false,
      note: err instanceof Error ? err.message : String(err),
      escalate: "gate-invalid",
    };
  }
  const ids = await gateTestIds(ctx);
  const verified = verifyRedBaseline(workspaceOf(ctx), ids, report);
  return {
    name: "red-baseline",
    ok: verified.ok,
    note: verified.detail,
    ...(verified.escalate ? { escalate: verified.escalate } : {}),
  };
}

function snapshotRoots(ctx: StepContext, arg?: string): string[] {
  if (arg === undefined || arg.length === 0) return ctx.cfg.writeRoots[ctx.state.kind] ?? [];
  const dir = (arg === "testDir" ? ctx.cfg.testDir : arg).replace(/\/+$/, "");
  if (dir.includes("*") || dir.includes("?") || dir.includes("{")) return [dir];
  return dir.length === 0 ? ["**"] : [dir, `${dir}/**`];
}

async function snapshotGate(ctx: StepContext, gate: string): Promise<PredicateResult> {
  const { arg } = parsePredicate(gate);
  const before = await loadJsonArtifact<Snapshot>(ctx, ART_SNAPSHOT_BEFORE, SNAPSHOT_FILE);
  if (before === null || before.files === undefined) {
    return { name: gate, ok: false, note: "no snapshot.before" };
  }
  let after: Snapshot;
  try {
    after = await snapshotTree(workspaceOf(ctx));
  } catch (err) {
    return { name: gate, ok: false, note: err instanceof Error ? err.message : String(err) };
  }
  const roots = snapshotRoots(ctx, arg);
  const outside = diffOutsideRoots(before, after, roots);
  return {
    name: gate,
    ok: outside.length === 0,
    note: outside.length === 0 ? undefined : `outside roots: ${outside.join(", ")}`,
  };
}

async function manifestRecord(ctx: StepContext): Promise<PredicateResult> {
  try {
    await captureManifest(ctx);
    return { name: "manifest-record", ok: true };
  } catch (err) {
    return { name: "manifest-record", ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

async function latestVerdict(runDir: string, stage: string): Promise<Record<string, unknown> | null> {
  let names: string[];
  try {
    names = await readdir(join(runDir, "_verdicts"));
  } catch {
    return null;
  }
  const prefix = `${stage}-r`;
  let best: { round: number; name: string } | null = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const round = Number(name.slice(prefix.length, -".json".length));
    if (!Number.isFinite(round)) continue;
    if (best === null || round > best.round) best = { round, name };
  }
  if (best === null) return null;
  try {
    return JSON.parse(await readFile(join(runDir, "_verdicts", best.name), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

async function manifestGate(ctx: StepContext): Promise<PredicateResult> {
  const manifest = await loadJsonArtifact<Manifest>(ctx, ART_MANIFEST, MANIFEST_FILE);
  if (manifest === null || manifest.files === undefined) {
    return { name: "manifest", ok: false, note: "no recorded manifest" };
  }
  const verdict = await latestVerdict(ctx.runDir, "implement");
  const declared = {
    testChanges: stringList(verdict?.["testChanges"]),
    ...(typeof verdict?.["collectedCount"] === "number" ? { collectedCount: verdict["collectedCount"] as number } : {}),
  };
  try {
    const verified = await verifyManifestUnchanged(workspaceOf(ctx), manifest, declared);
    return {
      name: "manifest",
      ok: verified.ok,
      note: verified.detail,
      ...(verified.escalate ? { escalate: verified.escalate } : {}),
    };
  } catch (err) {
    return { name: "manifest", ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

async function testInfraRestore(ctx: StepContext): Promise<PredicateResult> {
  const globs = ctx.cfg.testInfra;
  if (globs.length === 0) return { name: "test-infra-restore", ok: true };
  const ws = workspaceOf(ctx);
  const base = ctx.state.baseSha;
  let working: string[] = [];
  try {
    working = await listWorkingTree(ws);
  } catch (err) {
    return { name: "test-infra-restore", ok: false, note: err instanceof Error ? err.message : String(err) };
  }
  const listed = await hostGit(["ls-tree", "-r", "--name-only", "-z", base], { cwd: ws.path });
  if (listed.code !== 0) {
    return { name: "test-infra-restore", ok: false, note: listed.stderr.trim() || "ls-tree failed" };
  }
  const atBase = listed.stdout.split("\0").filter((p) => p.length > 0);
  const rels = [...new Set([...working, ...atBase].filter((p) => matchesAny(p, globs)))].sort();
  const drifted: string[] = [];
  for (const rel of rels) {
    const show = await hostGit(["show", `${base}:${rel}`], { cwd: ws.path });
    const now = await readText(join(ws.path, rel));
    const before = show.code === 0 ? show.stdout : null;
    if (before !== now) drifted.push(rel);
  }
  return {
    name: "test-infra-restore",
    ok: drifted.length === 0,
    note: drifted.length === 0 ? undefined : `drifted: ${drifted.join(", ")}`,
  };
}

async function flakyRerun(result: StepResult): Promise<PredicateResult> {
  const commands = result.evidence?.commands ?? [];
  if (commands.length === 0) return { name: "flaky-rerun", ok: false, note: "no check results" };
  const green = commands.every((c) => c.exitCode === 0 && !result.evidence?.timedOut);
  return {
    name: "flaky-rerun",
    ok: green,
    note: green ? undefined : "last check still failed after rerun",
  };
}

async function finalizeOnce(ctx: StepContext) {
  return finalize({
    ws: workspaceOf(ctx),
    baseSha: ctx.state.baseSha,
    writeRoots: ctx.cfg.writeRoots[ctx.state.kind] ?? [],
    maxDiffLines: ctx.cfg.maxDiffLines,
    maxChangedFiles: ctx.cfg.maxChangedFiles,
    generatedDocPatterns: ctx.cfg.generatedDocPatterns,
  });
}

async function finalizeGate(ctx: StepContext): Promise<PredicateResult> {
  try {
    const fin = await finalizeOnce(ctx);
    return { name: "finalize", ok: fin.ok, note: fin.ok ? undefined : fin.detail };
  } catch (err) {
    return { name: "finalize", ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

async function scopeReport(ctx: StepContext): Promise<PredicateResult> {
  try {
    const fin = await finalizeOnce(ctx);
    const outside = fin.scope.outOfScope;
    return {
      name: "scope-report",
      ok: outside.length === 0,
      note: outside.length === 0 ? undefined : `out of scope: ${outside.join(", ")}`,
    };
  } catch (err) {
    return { name: "scope-report", ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

async function citationsGate(ctx: StepContext): Promise<PredicateResult> {
  const text = await readText(join(ctx.runDir, "review.md"));
  if (text === null) return { name: "citations", ok: false, note: "missing review.md" };
  if (PATH_LINE_RE.test(text) || JUNIT_ID_RE.test(text)) return { name: "citations", ok: true };
  const junit = await readJunitReport(ctx);
  if (junit.xml !== undefined) {
    try {
      const report = parseJunit(junit.xml);
      if (report.cases.some((c) => c.id.length > 0 && text.includes(c.id))) return { name: "citations", ok: true };
    } catch {
      /* ignore parse errors; still fail closed below */
    }
  }
  return { name: "citations", ok: false, note: "review.md has no path:line or junit id" };
}

function parseBlocking(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return stringList((parsed as Record<string, unknown>)["blocking"]);
    }
  } catch {
    /* markdown */
  }
  const lines = text.split(/\r?\n/);
  const items: string[] = [];
  let inBlocking = false;
  for (const line of lines) {
    if (/^#{1,6}\s+blocking\s*$/i.test(line)) {
      inBlocking = true;
      continue;
    }
    if (inBlocking && /^#{1,6}\s+/.test(line)) break;
    if (inBlocking) {
      const m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (m?.[1] && !/^(none|n\/a|no blocking)\b/i.test(m[1].trim())) items.push(m[1].trim());
    }
  }
  return items;
}

function isApproved(text: string | null, result: StepResult, flags: string[]): boolean {
  if (result.verdict === "PASS") return true;
  if (flags.some((f) => /^(approved|pass)$/i.test(f))) return true;
  if (text === null) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const verdict = (parsed as Record<string, unknown>)["verdict"];
      if (typeof verdict === "string" && /^(PASS|approved)$/i.test(verdict)) return true;
    }
  } catch {
    /* markdown */
  }
  return /\b(approved|PASS)\b/.test(text);
}

async function verdictConsistent(ctx: StepContext, result: StepResult): Promise<PredicateResult> {
  const text = await readText(join(ctx.runDir, "review.md"));
  const review = await latestVerdict(ctx.runDir, "review");
  const flags = [...stringList(review?.["flags"]), ...stringList((result as { flags?: unknown }).flags)];
  const blocking = [
    ...parseBlocking(text ?? ""),
    ...stringList(review?.["blocking"]),
  ];
  const approved = isApproved(text, result, flags);
  if (approved && blocking.length > 0) {
    return { name: "verdict-consistent", ok: false, note: `PASS/approved with blocking: ${blocking.join(", ")}` };
  }
  return { name: "verdict-consistent", ok: true };
}

interface Acceptance {
  id: string;
  text: string;
}

async function loadAcceptance(ctx: StepContext): Promise<Acceptance[]> {
  const out: Acceptance[] = [];
  const seen = new Set<string>();
  const add = (id: string, text: string): void => {
    const key = `${id}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, text });
  };
  const briefRaw = await readText(join(ctx.runDir, "brief.json"));
  if (briefRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(briefRaw);
      if (typeof parsed === "object" && parsed !== null) {
        const acs = (parsed as Record<string, unknown>)["acceptanceCriteria"];
        if (Array.isArray(acs)) {
          for (const item of acs) {
            if (typeof item !== "object" || item === null) continue;
            const rec = item as Record<string, unknown>;
            if (typeof rec.id === "string" && typeof rec.text === "string") add(rec.id, rec.text);
          }
        }
      }
    } catch {
      /* ignore malformed brief */
    }
  }
  const plan = (await readText(join(ctx.runDir, "plan.md"))) ?? "";
  for (const m of plan.matchAll(AC_LINE_RE)) {
    if (m[1] !== undefined) add(`AC${m[1]}`, (m[2] ?? "").trim());
  }
  return out;
}

async function walkFiles(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  return names.map((rel) => join(root, rel));
}

async function testsCorpus(ctx: StepContext): Promise<string> {
  const root = join(ctx.workspaceDir, ctx.cfg.testDir);
  const files = await walkFiles(root);
  const parts: string[] = [];
  for (const path of files) {
    const text = await readText(path);
    if (text !== null) parts.push(text);
  }
  return parts.join("\n");
}

async function evidenceCorpus(ctx: StepContext): Promise<string> {
  const listed = await listEvidence(ctx.runDir);
  const parts: string[] = [];
  for (const rec of listed) {
    const ev = await readEvidence(ctx.runDir, rec.stage, rec.round);
    if (ev) parts.push(JSON.stringify(ev));
  }
  const review = await readText(join(ctx.runDir, "review.md"));
  if (review !== null) parts.push(review);
  return parts.join("\n");
}

function mentioned(haystack: string, ac: Acceptance): boolean {
  if (ac.id.length > 0 && haystack.includes(ac.id)) return true;
  return ac.text.length > 0 && haystack.includes(ac.text);
}

async function checklistGate(ctx: StepContext): Promise<PredicateResult> {
  const acs = await loadAcceptance(ctx);
  if (acs.length === 0) return { name: "checklist", ok: true };
  const reviewEv = await evidenceCorpus(ctx);
  const tests = await testsCorpus(ctx);
  const missing = acs.filter((ac) => !mentioned(reviewEv, ac) && !mentioned(tests, ac));
  return {
    name: "checklist",
    ok: missing.length === 0,
    note: missing.length === 0 ? undefined : `AC absent from evidence/review and tests: ${missing.map((a) => a.id).join(", ")}`,
  };
}

async function acSpotcheck(ctx: StepContext): Promise<PredicateResult> {
  const acs = await loadAcceptance(ctx);
  if (acs.length === 0) return { name: "ac-spotcheck", ok: true };
  const tests = await testsCorpus(ctx);
  const hit = acs.some((ac) => mentioned(tests, ac));
  return {
    name: "ac-spotcheck",
    ok: hit,
    note: hit ? undefined : "no AC string appears in a test file",
  };
}

async function depsApproval(ctx: StepContext): Promise<PredicateResult> {
  const verdict = await latestVerdict(ctx.runDir, "implement");
  const requested = stringList(verdict?.["dependenciesRequested"]);
  if (requested.length === 0) return { name: "deps-approval", ok: true };
  const art = ctx.state.artifacts[ART_DEPS_APPROVAL];
  const approved =
    (art !== undefined && art.length > 0) ||
    (await pathExists(join(ctx.runDir, ART_DEPS_APPROVAL))) ||
    (art !== undefined && (await pathExists(art)));
  return {
    name: "deps-approval",
    ok: approved,
    note: approved ? undefined : `dependenciesRequested without ${ART_DEPS_APPROVAL}: ${requested.join(", ")}`,
  };
}

function issuesKey(issues: string[] | undefined): string {
  return JSON.stringify(issues ?? []);
}

async function stuckDetector(ctx: StepContext): Promise<PredicateResult> {
  const stage = ctx.state.currentStep;
  const prior = ctx.state.steps.filter((s) => s.name === stage);
  if (prior.length < 2) return { name: "stuck-detector", ok: true };
  const last = prior[prior.length - 1];
  const prev = prior[prior.length - 2];
  const a = issuesKey(last?.issues);
  const b = issuesKey(prev?.issues);
  if (a !== b || a === "[]") return { name: "stuck-detector", ok: true };
  return {
    name: "stuck-detector",
    ok: false,
    note: `last two ${stage} records have identical issues`,
    escalate: "stall",
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
    if (gate === "no-synthesized") {
      out.push(await noSynthesized(ctx));
      continue;
    }
    if (gate === "preflight") {
      out.push(await preflightGate(ctx));
      continue;
    }
    if (gate.startsWith("sections:")) {
      out.push(await sectionsGate(ctx, gate.slice("sections:".length)));
      continue;
    }
    if (gate === "red-baseline") {
      out.push(await redBaseline(ctx));
      continue;
    }
    if (gate === "snapshot" || gate.startsWith("snapshot:")) {
      out.push(await snapshotGate(ctx, gate));
      continue;
    }
    if (gate === "manifest-record") {
      out.push(await manifestRecord(ctx));
      continue;
    }
    if (gate === "manifest") {
      out.push(await manifestGate(ctx));
      continue;
    }
    if (gate === "test-infra-restore") {
      out.push(await testInfraRestore(ctx));
      continue;
    }
    if (gate === "flaky-rerun") {
      out.push(await flakyRerun(result));
      continue;
    }
    if (gate === "finalize") {
      out.push(await finalizeGate(ctx));
      continue;
    }
    if (gate === "citations") {
      out.push(await citationsGate(ctx));
      continue;
    }
    if (gate === "verdict-consistent") {
      out.push(await verdictConsistent(ctx, result));
      continue;
    }
    if (gate === "scope-report") {
      out.push(await scopeReport(ctx));
      continue;
    }
    if (gate === "checklist") {
      out.push(await checklistGate(ctx));
      continue;
    }
    if (gate === "ac-spotcheck") {
      out.push(await acSpotcheck(ctx));
      continue;
    }
    if (gate === "deps-approval") {
      out.push(await depsApproval(ctx));
      continue;
    }
    if (gate === "stuck-detector") {
      out.push(await stuckDetector(ctx));
      continue;
    }
    out.push({
      name: gate,
      ok: false,
      note: isPredicate(gate) ? "predicate not implemented" : "unknown predicate",
    });
  }
  return out;
}

export function allGatesOk(results: PredicateResult[]): boolean {
  return results.every((r) => r.ok);
}
