// src/git/patch-id.ts — stable git patch-ids for land-reconcile (spec §6.5).
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildHostGitArgv, hostGit, hostGitEnv, hostGitOk } from "./host-git.js";

export interface PatchIdLine {
  sha: string;
  patchId: string;
}

function gitWithStdin(args: string[], input: string, cwd: string): Promise<string> {
  const argv = buildHostGitArgv(args);
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      argv,
      { cwd, env: hostGitEnv(), timeout: 120_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") return reject(err);
        resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}

function parsePatchId(stdout: string): PatchIdLine[] {
  const out: PatchIdLine[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (line === "") continue;
    const [patchId, sha] = line.split(/\s+/);
    if (patchId !== undefined && patchId.length > 0) out.push({ patchId, sha: sha ?? "" });
  }
  return out;
}

/** `git log -p --format=%H <revRange> | git patch-id --stable` → patch-id per commit. */
export async function stablePatchId(cwd: string, revRange: string): Promise<string[]> {
  const log = await hostGit(["log", "-p", "--reverse", "--format=%H", revRange], { cwd });
  if (log.code !== 0 || log.stdout.trim() === "") return [];
  return parsePatchId(await gitWithStdin(["patch-id", "--stable"], log.stdout, cwd)).map((l) => l.patchId);
}

export async function stableDiffPatchId(cwd: string, from: string, to: string): Promise<string | null> {
  const diff = await hostGit(["diff", from, to], { cwd });
  if (diff.code !== 0 || diff.stdout.trim() === "") return null;
  return parsePatchId(await gitWithStdin(["patch-id", "--stable"], diff.stdout, cwd))[0]?.patchId ?? null;
}

export async function patchIdOfCommit(cwd: string, sha: string): Promise<string | null> {
  const ids = await stablePatchId(cwd, `${sha}^!`);
  return ids[0] ?? null;
}

const CACHE_CAP = 5000;

export function patchIdCachePath(runsDir: string, repoSlug: string): string {
  return join(runsDir, "_factory", "repo-index", repoSlug, "patch-ids.jsonl");
}

export async function readPatchIdCache(path: string): Promise<Map<string, string>> {
  try {
    const raw = await readFile(path, "utf8");
    const map = new Map<string, string>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const rec = JSON.parse(line) as Partial<PatchIdLine>;
      if (typeof rec.sha === "string" && typeof rec.patchId === "string") map.set(rec.sha, rec.patchId);
    }
    return map;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

export async function appendPatchIdCache(path: string, lines: PatchIdLine[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { encoding: "utf8" });
  const raw = await readFile(path, "utf8");
  const all = raw.split("\n").filter((l) => l.trim() !== "");
  if (all.length <= CACHE_CAP) return;
  await writeFile(path, `${all.slice(all.length - CACHE_CAP).join("\n")}\n`, { encoding: "utf8" });
}

export async function windowPatchIds(
  cwd: string,
  range: string,
  cache?: { path: string; map: Map<string, string> },
): Promise<{ shas: string[]; ids: string[] }> {
  const listed = await hostGitOk(["log", "--reverse", "--format=%H", range], { cwd }).catch(() => "");
  const shas = listed === "" ? [] : listed.split("\n").filter((s) => s.length > 0);
  const ids: string[] = [];
  const fresh: PatchIdLine[] = [];
  for (const sha of shas) {
    let id = cache?.map.get(sha);
    if (id === undefined) {
      id = (await patchIdOfCommit(cwd, sha)) ?? "";
      if (id !== "") {
        cache?.map.set(sha, id);
        fresh.push({ sha, patchId: id });
      }
    }
    if (id !== "") ids.push(id);
  }
  if (cache !== undefined) await appendPatchIdCache(cache.path, fresh);
  return { shas, ids };
}
