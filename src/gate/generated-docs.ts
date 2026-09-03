import { open } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { GENERATED_DOC_PATTERNS } from "../config/defaults.js";
import { generatedMarker } from "../home.js";
import type { Workspace } from "../workspace/types.js";
import { matchesAny, normalizeRelPath } from "./glob.js";

// The locked marker has exactly one definition, in src/home.ts (Task 0.2).
// generatedMarkerLine is a re-export; GENERATED_MARKER is the prefix of that line
// (home.ts does not export the prefix constant).
export { generatedMarker as generatedMarkerLine } from "../home.js";
// Single source of truth is src/config/defaults.ts (D18). Do not duplicate the list.
export { GENERATED_DOC_PATTERNS } from "../config/defaults.js";

const MARKER_ID = "_id_";
export const GENERATED_MARKER: string = generatedMarker(MARKER_ID).slice(
  0,
  generatedMarker(MARKER_ID).indexOf(` ${MARKER_ID} `),
);

const HEAD_BYTES = 512;

async function firstLineHasMarker(absPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(absPath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
    return firstLine.includes(GENERATED_MARKER);
  } finally {
    await handle.close();
  }
}

export async function findGeneratedDocs(
  ws: Workspace,
  changedFiles: string[],
  patterns: readonly string[] = GENERATED_DOC_PATTERNS,
): Promise<string[]> {
  const found = new Set<string>();
  for (const file of changedFiles) {
    const rel = normalizeRelPath(isAbsolute(file) ? relative(ws.path, file) : file);
    if (rel.length === 0) continue;
    if (matchesAny(rel, patterns)) {
      found.add(rel);
      continue;
    }
    if (await firstLineHasMarker(join(ws.path, rel))) found.add(rel);
  }
  return [...found].sort();
}
