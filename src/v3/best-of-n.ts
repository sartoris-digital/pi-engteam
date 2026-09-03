// src/v3/best-of-n.ts — N sibling worktrees + AST consensus (spec §10.3). Flag default off.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Verdict } from "../engine/types.js";
import type { CreateWorkspaceRequest, Workspace, WorkspaceProvider } from "../workspace/types.js";
import { v3Enabled, type V3HostConfig } from "./dispatch.js";

export type ConsensusMethod = "ast-equal" | "majority" | "fallback-first";

export interface AstParser {
  /** Comparable fingerprint, or null to fall through to the default/normalized form. */
  fingerprint(source: string, filePath: string): string | null;
}

export interface ConsensusCandidate {
  id: string;
  files: Record<string, string>;
}

export interface ConsensusResult {
  files: Record<string, string>;
  method: ConsensusMethod;
  discarded: string[];
  winner: string;
}

export type V3BestOfNConfig = V3HostConfig;

export interface ImplementResult {
  files: Record<string, string>;
  verdict: Verdict;
}

export interface ParallelGuard {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface BestOfNResult {
  verdict: Verdict;
  files: Record<string, string>;
  copied: boolean;
  evidence?: { bestOfN: { n: number; winner: string | null; method: ConsensusMethod } };
}

export interface RunBestOfNOptions {
  cfg: V3BestOfNConfig;
  primary: Workspace;
  n?: number;
  suffix?: string;
  runImplement: (ws: Workspace) => Promise<ImplementResult>;
  createSiblings?: (ws: Workspace, n: number, suffix: string) => Promise<Workspace[]>;
  provider?: WorkspaceProvider;
  base?: string;
  applyFiles?: (ws: Workspace, files: Record<string, string>) => Promise<void>;
  checkpoint?: (ws: Workspace) => Promise<unknown>;
  parser?: AstParser;
  guard?: ParallelGuard;
}

const JS_LIKE = /\.(?:[cm]?[jt]sx?)$/;

function isJsLike(filePath: string): boolean {
  return JS_LIKE.test(filePath);
}

export function normalizeWs(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

/** Strip comments and collapse whitespace; string/template contents are preserved. */
export function normalizeTrivia(source: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "squote" | "dquote" | "template" | "line" | "block" = "code";
  while (i < source.length) {
    const c = source[i]!;
    const n = source[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "'") {
        mode = "squote";
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        mode = "dquote";
        out += c;
        i += 1;
        continue;
      }
      if (c === "`") {
        mode = "template";
        out += c;
        i += 1;
        continue;
      }
      if (/\s/.test(c)) {
        if (out.length > 0 && !out.endsWith(" ")) out += " ";
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        if (out.length > 0 && !out.endsWith(" ")) out += " ";
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    out += c;
    if (c === "\\" && n !== undefined) {
      out += n;
      i += 2;
      continue;
    }
    if ((mode === "squote" && c === "'") || (mode === "dquote" && c === '"') || (mode === "template" && c === "`")) {
      mode = "code";
    }
    i += 1;
  }
  return out.trim();
}

let tsMod: typeof import("typescript") | null | undefined;

function loadTypescript(): typeof import("typescript") | null {
  if (tsMod !== undefined) return tsMod;
  try {
    tsMod = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  } catch {
    tsMod = null;
  }
  return tsMod;
}

function tsFingerprint(source: string, filePath: string): string | null {
  const ts = loadTypescript();
  if (ts === null) return null;
  let kind = ts.ScriptKind.TS;
  if (filePath.endsWith(".tsx")) kind = ts.ScriptKind.TSX;
  else if (filePath.endsWith(".jsx")) kind = ts.ScriptKind.JSX;
  else if (/\.[cm]?js$/.test(filePath)) kind = ts.ScriptKind.JS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  return normalizeWs(printer.printFile(sf));
}

function fileFingerprint(content: string, filePath: string, parser?: AstParser): string {
  if (isJsLike(filePath)) {
    if (parser !== undefined) {
      const fp = parser.fingerprint(content, filePath);
      if (fp !== null) return fp;
    }
    const tsFp = tsFingerprint(content, filePath);
    if (tsFp !== null) return tsFp;
    return normalizeTrivia(content);
  }
  return normalizeWs(content);
}

export function consensus(candidates: ConsensusCandidate[], opts?: { parser?: AstParser }): ConsensusResult {
  if (candidates.length === 0) throw new Error("consensus requires at least one candidate");
  const paths = new Set<string>();
  for (const c of candidates) {
    for (const p of Object.keys(c.files)) paths.add(p);
  }
  const files: Record<string, string> = {};
  const discarded = new Set<string>();
  let method: ConsensusMethod = "ast-equal";

  for (const filePath of paths) {
    const entries = candidates.map((c) => {
      const content = c.files[filePath] ?? "";
      return { id: c.id, content, fp: fileFingerprint(content, filePath, opts?.parser) };
    });
    const clusters = new Map<string, string[]>();
    for (const e of entries) {
      const ids = clusters.get(e.fp) ?? [];
      ids.push(e.id);
      clusters.set(e.fp, ids);
    }
    const majority = [...clusters.entries()].find(([, ids]) => ids.length * 2 > entries.length);
    const first = entries[0]!;
    if (majority !== undefined && majority[1]!.length === entries.length) {
      files[filePath] = first.content;
      continue;
    }
    if (majority !== undefined) {
      if (method !== "fallback-first") method = "majority";
      const winnerIds = majority[1]!;
      const winnerId = winnerIds[0]!;
      const chosen = entries.find((e) => e.id === winnerId) ?? first;
      files[filePath] = chosen.content;
      for (const e of entries) {
        if (!winnerIds.includes(e.id)) discarded.add(e.id);
      }
      continue;
    }
    method = "fallback-first";
    files[filePath] = first.content;
    for (const e of entries.slice(1)) discarded.add(e.id);
  }

  const winner =
    candidates.find((c) => Object.keys(files).every((p) => (c.files[p] ?? "") === files[p]))?.id ?? candidates[0]!.id;
  return { files, method, discarded: [...discarded], winner };
}

export function assertRelPath(rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (normalized.startsWith("/") || parts.includes("..") || parts.includes("")) {
    throw new Error(`refusing path escape: ${rel}`);
  }
  return parts.join("/");
}

export async function applyFilesToWorkspace(ws: Workspace, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const safe = assertRelPath(rel);
    const dest = path.join(ws.path, safe);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
}

export interface CreateSiblingsOptions {
  provider: WorkspaceProvider;
  base?: string;
}

export async function createSiblings(
  ws: Workspace,
  n: number,
  suffix: string,
  opts: CreateSiblingsOptions,
): Promise<Workspace[]> {
  if (!Number.isInteger(n) || n < 1) throw new Error(`createSiblings n must be >= 1, got ${n}`);
  const out: Workspace[] = [];
  const baseName = path.basename(ws.path);
  for (let i = 0; i < n; i++) {
    const req: CreateWorkspaceRequest = {
      repoRoot: ws.repoRoot,
      branch: `${ws.branch}-${suffix}-${i}`,
      base: opts.base ?? "main",
      slug: `${baseName}-${suffix}-${i}`,
      lockReason: `factory:sibling:${suffix}:${i}`,
      remote: ws.remote,
    };
    out.push(await opts.provider.create(req));
  }
  return out;
}

export async function removeSiblings(
  siblings: readonly Workspace[],
  opts: { provider: WorkspaceProvider; force?: boolean },
): Promise<void> {
  for (const s of siblings) {
    await opts.provider.remove(s, { force: opts.force === true });
  }
}

function clampN(n: number | undefined): 2 | 3 {
  if (typeof n === "number" && Number.isFinite(n) && n >= 3) return 3;
  return 2;
}

function siblingFactory(opts: RunBestOfNOptions): (ws: Workspace, n: number, suffix: string) => Promise<Workspace[]> {
  if (opts.createSiblings !== undefined) return opts.createSiblings;
  if (opts.provider !== undefined) {
    const provider = opts.provider;
    const base = opts.base;
    return (ws, n, suffix) => createSiblings(ws, n, suffix, { provider, base });
  }
  throw new Error("createSiblings or provider is required when v3.bestOfN is enabled");
}

export async function runBestOfN(opts: RunBestOfNOptions): Promise<BestOfNResult> {
  if (!v3Enabled(opts.cfg, "bestOfN")) {
    const single = await opts.runImplement(opts.primary);
    return { verdict: single.verdict, files: single.files, copied: false };
  }

  const n = clampN(opts.cfg.v3?.bestOfN?.n ?? opts.n);
  const suffix = opts.suffix ?? "bon";
  const create = siblingFactory(opts);
  const siblings = await create(opts.primary, n, suffix);
  const guard = opts.guard ?? { run: <T>(fn: () => Promise<T>) => fn() };
  const results = await Promise.all(
    siblings.map((ws, i) =>
      guard.run(async () => {
        const r = await opts.runImplement(ws);
        return { id: `bon-${i}`, ws, files: r.files, verdict: r.verdict };
      }),
    ),
  );

  const passed = results.filter((r) => r.verdict === "PASS");
  if (passed.length === 0) {
    const verdict: Verdict = results.some((r) => r.verdict === "FAIL") ? "FAIL" : "NEEDS_MORE";
    return {
      verdict,
      files: {},
      copied: false,
      evidence: { bestOfN: { n, winner: null, method: "fallback-first" } },
    };
  }

  const cons = consensus(
    passed.map((r) => ({ id: r.id, files: r.files })),
    { parser: opts.parser },
  );
  const apply = opts.applyFiles ?? applyFilesToWorkspace;
  await apply(opts.primary, cons.files);
  if (opts.checkpoint !== undefined) await opts.checkpoint(opts.primary);
  return {
    verdict: "PASS",
    files: cons.files,
    copied: true,
    evidence: { bestOfN: { n, winner: cons.winner, method: cons.method } },
  };
}
