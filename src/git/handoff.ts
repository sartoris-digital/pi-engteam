// src/git/handoff.ts — publish handoff record (spec §6.5). Landing is decided from git, not PR state.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Handoff {
  ref: string;
  runId: string;
  lane: string;
  branch: string;
  baseSha: string;
  judgedSha: string;
  hostCommits: string[];
  patchIds: string[];
  changedFiles: string[];
  writeGlobs: string[];
  prUrl?: string;
  publishedAt: string;
}

export async function writeHandoff(runDir: string, h: Handoff): Promise<string> {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, "handoff.json");
  await writeFile(path, `${JSON.stringify(h, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}
