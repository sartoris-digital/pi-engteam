// src/engine/verify.ts — v0 VerifierHook: dirty-tree + test-manifest (no uv scripts).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyManifestUnchanged, type Manifest } from "../gate/manifest.js";
import { matchesAny } from "../gate/glob.js";
import { hostGit } from "../git/host-git.js";
import type { Workspace } from "../workspace/types.js";
import { readGeneratedJson } from "./state.js";
import type { Step, StepContext, StepResult } from "./types.js";

const MANIFEST_KEYS = ["manifest", "test-manifest", "manifest.json"] as const;
const MANIFEST_FILES = ["test-manifest.json", "manifest.json"] as const;

function porcelainPath(line: string): string | undefined {
  if (line.length < 4 || line.startsWith("#") || line.charAt(2) !== " ") return undefined;
  let spec = line.slice(3);
  const arrow = spec.lastIndexOf(" -> ");
  if (arrow !== -1) spec = spec.slice(arrow + 4);
  if (spec.startsWith('"') && spec.endsWith('"') && spec.length >= 2) {
    spec = spec.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return spec;
}

function unexpectedDirty(stdout: string, patterns: readonly string[]): string[] {
  const dirty: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const path = porcelainPath(line);
    if (path === undefined || path.length === 0) continue;
    if (matchesAny(path, patterns)) continue;
    dirty.push(path);
  }
  return dirty;
}

function workspaceOf(ctx: StepContext): Workspace {
  const remote = ctx.state.artifacts["workspace.remote"];
  const remoteUrl = ctx.state.artifacts["workspace.remoteUrl"];
  return {
    provider: "git",
    path: ctx.workspaceDir,
    branch: ctx.state.branch,
    baseSha: ctx.state.baseSha,
    repoRoot: ctx.state.mainCheckout,
    gitCommonDir: ctx.state.artifacts["workspace.gitCommonDir"] ?? join(ctx.state.mainCheckout, ".git"),
    configSha: ctx.state.artifacts["workspace.configSha"] ?? ctx.state.configSha,
    ...(remote === undefined ? {} : { remote }),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  };
}

function manifestCandidates(ctx: StepContext, result: StepResult): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p === undefined || p.length === 0 || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const key of MANIFEST_KEYS) {
    add(result.artifacts?.[key]);
    add(ctx.state.artifacts[key]);
  }
  for (const rel of MANIFEST_FILES) add(join(ctx.runDir, rel));
  return out;
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.testDir === "string" && typeof rec.files === "object" && rec.files !== null;
}

async function loadManifest(path: string): Promise<Manifest | null> {
  try {
    const value = await readGeneratedJson<unknown>(path);
    return isManifest(value) ? value : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

async function declaredTestChanges(ctx: StepContext, step: Step): Promise<{ testChanges: string[]; collectedCount?: number }> {
  const dir = join(ctx.runDir, "_verdicts");
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { testChanges: [] };
  }
  const prefix = `${step.name}-r`;
  let best: { round: number; name: string } | null = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const round = Number(name.slice(prefix.length, -".json".length));
    if (!Number.isFinite(round)) continue;
    if (best === null || round > best.round) best = { round, name };
  }
  if (best === null) return { testChanges: [] };
  try {
    const raw = JSON.parse(await readFile(join(dir, best.name), "utf8")) as Record<string, unknown>;
    const testChanges = stringList(raw["testChanges"]);
    const collected = raw["collectedCount"];
    return typeof collected === "number" ? { testChanges, collectedCount: collected } : { testChanges };
  } catch {
    return { testChanges: [] };
  }
}

export async function defaultVerify(step: Step, ctx: StepContext, result: StepResult): Promise<StepResult> {
  if (result.evidence?.timedOut === true) {
    return { verdict: "FAIL", issues: [`verifier: step '${step.name}' timed out`] };
  }

  const status = await hostGit(["status", "--porcelain"], { cwd: ctx.workspaceDir });
  if (status.code !== 0) {
    const detail = status.stderr.trim() || `exit ${status.code}`;
    return { verdict: "FAIL", issues: [`verifier: git status failed: ${detail}`] };
  }
  const dirty = unexpectedDirty(status.stdout, ctx.cfg.generatedDocPatterns);
  if (dirty.length > 0) {
    return {
      verdict: "FAIL",
      issues: [`verifier: unexpected dirty files: ${dirty.join(", ")}`],
    };
  }

  const declared = await declaredTestChanges(ctx, step);
  for (const path of manifestCandidates(ctx, result)) {
    const manifest = await loadManifest(path);
    if (manifest === null) continue;
    const check = await verifyManifestUnchanged(workspaceOf(ctx), manifest, declared);
    if (check.ok) break;
    const out: StepResult = { verdict: "FAIL", issues: [`verifier: ${check.detail}`] };
    if (check.escalate === "test-tampering") out.escalate = "test-tampering";
    return out;
  }

  return { verdict: "PASS" };
}
