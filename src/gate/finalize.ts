import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "../workspace/types.js";
import { matchesAny, normalizeRelPath } from "./glob.js";
import { GENERATED_DOC_PATTERNS, findGeneratedDocs } from "./generated-docs.js";

export interface FinalizeInput {
  ws: Workspace;
  baseSha: string;
  writeRoots: string[];
  maxDiffLines: number;
  maxChangedFiles: number;
  generatedDocPatterns?: string[];
}

export type FinalizeCode = "scope-violation" | "too-large" | "generated-doc";

export interface FinalizeViolation {
  code: FinalizeCode;
  paths: string[];
  detail: string;
}

export interface ScopeReport {
  changedFiles: string[];
  inScope: string[];
  outOfScope: string[];
  diffLines: number;
  generatedDocs: string[];
}

export interface FinalizeResult {
  ok: boolean;
  scope: ScopeReport;
  violations: FinalizeViolation[];
  detail: string;
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(ws: Workspace, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: ws.path, maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function splitNul(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0).map(normalizeRelPath);
}

async function untrackedFiles(ws: Workspace): Promise<string[]> {
  return splitNul(await git(ws, ["ls-files", "-z", "--others", "--exclude-standard"]));
}

export async function changedFilesSince(ws: Workspace, baseSha: string): Promise<string[]> {
  const tracked = splitNul(await git(ws, ["diff", "--name-only", "-z", baseSha, "--"]));
  const untracked = await untrackedFiles(ws);
  return [...new Set([...tracked, ...untracked])].sort();
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

export async function diffLineCount(ws: Workspace, baseSha: string): Promise<number> {
  let lines = 0;
  for (const row of (await git(ws, ["diff", "--numstat", baseSha, "--"])).split("\n")) {
    if (row.trim().length === 0) continue;
    const [added, deleted] = row.split("\t");
    lines += (Number(added ?? "0") || 0) + (Number(deleted ?? "0") || 0); // binary rows are "-" → 0
  }
  for (const rel of await untrackedFiles(ws)) {
    try {
      lines += countLines(await readFile(join(ws.path, rel), "utf8"));
    } catch {
      // unreadable or vanished between listing and reading → contributes nothing
    }
  }
  return lines;
}

export async function finalize(input: FinalizeInput): Promise<FinalizeResult> {
  const changedFiles = await changedFilesSince(input.ws, input.baseSha);
  const diffLines = await diffLineCount(input.ws, input.baseSha);
  const generatedDocs = await findGeneratedDocs(input.ws, changedFiles, input.generatedDocPatterns ?? GENERATED_DOC_PATTERNS);
  const inScope = changedFiles.filter((p) => matchesAny(p, input.writeRoots));
  const outOfScope = changedFiles.filter((p) => !matchesAny(p, input.writeRoots));

  const violations: FinalizeViolation[] = [];
  if (outOfScope.length > 0) {
    violations.push({ code: "scope-violation", paths: outOfScope, detail: `${outOfScope.length} file(s) outside write roots` });
  }
  if (generatedDocs.length > 0) {
    violations.push({ code: "generated-doc", paths: generatedDocs, detail: "generated planning artifacts in the diff" });
  }
  const tooLarge: string[] = [];
  if (changedFiles.length > input.maxChangedFiles) tooLarge.push(`${changedFiles.length} changed files > ${input.maxChangedFiles}`);
  if (diffLines > input.maxDiffLines) tooLarge.push(`${diffLines} diff lines > ${input.maxDiffLines}`);
  if (tooLarge.length > 0) violations.push({ code: "too-large", paths: [], detail: tooLarge.join("; ") });

  const scope: ScopeReport = { changedFiles, inScope, outOfScope, diffLines, generatedDocs };
  const detail =
    violations.length === 0
      ? `${changedFiles.length} changed file(s), ${diffLines} diff line(s), all inside write roots`
      : violations.map((v) => `${v.code}: ${v.detail}`).join("; ");
  return { ok: violations.length === 0, scope, violations, detail };
}
