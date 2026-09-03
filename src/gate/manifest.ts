import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "../workspace/types.js";
import { matchGlob, matchesAny, normalizeRelPath } from "./glob.js";
import { listWorkingTree } from "./snapshot.js";

export interface Manifest {
  files: Record<string, string>;
  skipMarkers: Record<string, number>;
  collectedCount: number;
  testDir: string;
  testInfra: string[];
  recordedAt: string;
}

export interface DeclaredTestChanges {
  testChanges: string[];
  collectedCount?: number;
}

export type ManifestReason = "undeclared-test-changes" | "skip-markers-added" | "collected-count-decreased";

export interface ManifestResult {
  ok: boolean;
  escalate?: "test-tampering";
  reason?: ManifestReason;
  changed: string[];
  undeclared: string[];
  newSkipMarkers: { path: string; before: number; after: number }[];
  collectedBefore: number;
  collectedAfter?: number;
  detail: string;
}

export const SKIP_MARKER_PATTERNS: readonly RegExp[] = [
  /\b(?:it|test|describe|suite|context)\.skip\b/g,
  /\b(?:it|test|describe|suite|context)\.only\b/g,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/g,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/g,
  /\bpytest\.(?:skip|xfail)\s*\(/g,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/g,
];

export function countSkipMarkers(text: string): number {
  let count = 0;
  for (const pattern of SKIP_MARKER_PATTERNS) {
    const re = new RegExp(pattern.source, "g");
    count += (text.match(re) ?? []).length;
  }
  return count;
}

function inTestScope(rel: string, testDir: string, testInfra: readonly string[]): boolean {
  const dir = normalizeRelPath(testDir).replace(/\/+$/, "");
  const inDir = dir === "" ? true : rel === dir || rel.startsWith(`${dir}/`);
  return inDir || matchesAny(rel, testInfra);
}

interface ScopeScan {
  files: Record<string, string>;
  skipMarkers: Record<string, number>;
}

async function scanScope(ws: Workspace, testDir: string, testInfra: readonly string[]): Promise<ScopeScan> {
  const files: Record<string, string> = {};
  const skipMarkers: Record<string, number> = {};
  for (const rel of await listWorkingTree(ws)) {
    if (!inTestScope(rel, testDir, testInfra)) continue;
    let buf: Buffer;
    try {
      buf = await readFile(join(ws.path, rel));
    } catch {
      continue; // deleted from the working tree
    }
    files[rel] = createHash("sha256").update(buf).digest("hex");
    skipMarkers[rel] = countSkipMarkers(buf.toString("utf8"));
  }
  return { files, skipMarkers };
}

export async function recordManifest(
  ws: Workspace,
  testDir: string,
  testInfra: string[],
  opts: { collectedCount?: number } = {},
): Promise<Manifest> {
  const scan = await scanScope(ws, testDir, testInfra);
  return {
    files: scan.files,
    skipMarkers: scan.skipMarkers,
    collectedCount: opts.collectedCount ?? 0,
    testDir,
    testInfra: [...testInfra],
    recordedAt: new Date().toISOString(),
  };
}

export async function verifyManifestUnchanged(
  ws: Workspace,
  manifest: Manifest,
  declared: DeclaredTestChanges,
): Promise<ManifestResult> {
  const now = await scanScope(ws, manifest.testDir, manifest.testInfra);

  const changedSet = new Set<string>();
  for (const [path, sha] of Object.entries(now.files)) {
    if (manifest.files[path] !== sha) changedSet.add(path);
  }
  for (const path of Object.keys(manifest.files)) {
    if (!(path in now.files)) changedSet.add(path);
  }
  const changed = [...changedSet].sort();

  const declaredPaths = declared.testChanges.map(normalizeRelPath);
  const isDeclared = (p: string): boolean => declaredPaths.some((d) => d === p || matchGlob(p, d));
  const undeclared = changed.filter((p) => !isDeclared(p));

  const newSkipMarkers = changed
    .filter((p) => p in now.skipMarkers)
    .map((p) => ({ path: p, before: manifest.skipMarkers[p] ?? 0, after: now.skipMarkers[p] ?? 0 }))
    .filter((m) => m.after > m.before);

  const collectedBefore = manifest.collectedCount;
  const collectedAfter = declared.collectedCount;
  const base = { changed, undeclared, newSkipMarkers, collectedBefore, collectedAfter };

  if (newSkipMarkers.length > 0) {
    return {
      ok: false,
      escalate: "test-tampering",
      reason: "skip-markers-added",
      detail: `new skip/only markers in ${newSkipMarkers.map((m) => m.path).join(", ")}`,
      ...base,
    };
  }
  if (collectedAfter !== undefined && collectedAfter < collectedBefore) {
    return {
      ok: false,
      escalate: "test-tampering",
      reason: "collected-count-decreased",
      detail: `collected test count decreased from ${collectedBefore} to ${collectedAfter}`,
      ...base,
    };
  }
  if (undeclared.length > 0) {
    return {
      ok: false,
      reason: "undeclared-test-changes",
      detail: `undeclared changes under ${manifest.testDir} / test infra: ${undeclared.join(", ")}`,
      ...base,
    };
  }
  return {
    ok: true,
    detail: changed.length > 0 ? `declared test changes: ${changed.join(", ")}` : "test tree unchanged",
    ...base,
  };
}
