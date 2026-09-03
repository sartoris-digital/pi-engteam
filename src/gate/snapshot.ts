import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "../workspace/types.js";
import { matchesAny, normalizeRelPath } from "./glob.js";

export interface Snapshot {
  files: Record<string, string>;
  at: string;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function listWorkingTree(ws: Workspace): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: ws.path, maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const paths = stdout
          .split("\0")
          .filter((p) => p.length > 0)
          .map(normalizeRelPath);
        resolve([...new Set(paths)].sort());
      },
    );
  });
}

export async function snapshotTree(ws: Workspace): Promise<Snapshot> {
  const files: Record<string, string> = {};
  for (const rel of await listWorkingTree(ws)) {
    const abs = join(ws.path, rel);
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue; // tracked but deleted from the working tree
    }
    if (!info.isFile()) continue;
    files[rel] = await sha256File(abs);
  }
  return { files, at: new Date().toISOString() };
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, sha] of Object.entries(after.files)) {
    const prev = before.files[path];
    if (prev === undefined) added.push(path);
    else if (prev !== sha) changed.push(path);
  }
  for (const path of Object.keys(before.files)) {
    if (!(path in after.files)) removed.push(path);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export function diffOutsideRoots(before: Snapshot, after: Snapshot, roots: readonly string[]): string[] {
  const diff = diffSnapshots(before, after);
  return [...diff.added, ...diff.removed, ...diff.changed].filter((p) => !matchesAny(p, roots)).sort();
}
