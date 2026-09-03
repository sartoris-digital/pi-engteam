import { execFile } from "node:child_process";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { matchesAny, normalizeRelPath } from "../gate/glob.js";
import { hostGitOk } from "../git/host-git.js";
import { devFixtureDir, sealedDir, sealedFixtureDir, stagingDir } from "./layout.js";

const execFileAsync = promisify(execFile);

export interface FixtureMember {
  repo: string;
  parentSha: string;
  expectedPatch: string;
  input: unknown;
}

export interface MaterialiseOpts {
  home: string;
  name: string;
  stagingId: string;
  members: FixtureMember[];
  readGlobs: string[];
  denyGlobs: string[];
}

export interface MaterialiseResult {
  dev: string[];
  sealed: string[];
}

export async function materialiseFixtures(opts: MaterialiseOpts): Promise<MaterialiseResult> {
  const k = opts.members.length;
  const devCount = Math.ceil(k / 2);
  const result: MaterialiseResult = { dev: [], sealed: [] };

  await mkdir(stagingDir(opts.home, opts.stagingId), { recursive: true, mode: 0o700 });
  const sealedRoot = sealedDir(opts.home, opts.name);
  await mkdir(sealedRoot, { recursive: true, mode: 0o700 });
  await chmod(sealedRoot, 0o700);

  for (let i = 0; i < k; i++) {
    const member = opts.members[i];
    if (member === undefined) continue;
    const isDev = i < devCount;
    const dest = isDev
      ? devFixtureDir(opts.home, opts.stagingId, i)
      : sealedFixtureDir(opts.home, opts.name, i);
    await materialiseOne(dest, member, opts.readGlobs, opts.denyGlobs);
    if (isDev) result.dev.push(dest);
    else result.sealed.push(dest);
  }

  return result;
}

async function materialiseOne(
  dest: string,
  member: FixtureMember,
  readGlobs: string[],
  denyGlobs: string[],
): Promise<void> {
  const beforeDir = join(dest, "before");
  await mkdir(beforeDir, { recursive: true, mode: 0o700 });

  const names = await listTree(member.repo, member.parentSha);
  const keep = names.filter((n) => keepPath(n, readGlobs, denyGlobs));
  if (keep.length > 0) {
    const tarPath = join(dest, ".archive.tar");
    await hostGitOk(["archive", "-o", tarPath, member.parentSha, "--", ...keep], { cwd: member.repo });
    try {
      await execFileAsync("tar", ["-xf", tarPath, "-C", beforeDir], { timeout: 60_000 });
    } finally {
      await unlink(tarPath).catch(() => undefined);
    }
  }

  await writeFile(join(dest, "input.json"), `${JSON.stringify(member.input, null, 2)}\n`, "utf8");
  await writeFile(join(dest, "expected.patch"), member.expectedPatch, "utf8");
}

async function listTree(repo: string, sha: string): Promise<string[]> {
  const out = await hostGitOk(["ls-tree", "-r", "--name-only", sha], { cwd: repo });
  if (out.length === 0) return [];
  return out.split("\n").map((n) => n.trim()).filter((n) => n.length > 0);
}

function keepPath(path: string, readGlobs: string[], denyGlobs: string[]): boolean {
  const rel = normalizeRelPath(path);
  if (denyGlobs.length > 0 && matchesAny(rel, denyGlobs)) return false;
  if (readGlobs.length === 0) return true;
  return matchesAny(rel, readGlobs);
}

function isExpectedName(path: string): boolean {
  const rel = normalizeRelPath(path);
  const base = rel.split("/").pop() ?? rel;
  return base.startsWith("expected.");
}

export function assertNoFixtureEdits(
  before: Map<string, string>,
  after: Map<string, string>,
): { ok: boolean; edited: string[] } {
  const edited: string[] = [];
  for (const [path, content] of before) {
    if (!isExpectedName(path)) continue;
    const next = after.get(path);
    if (next !== content) edited.push(path);
  }
  for (const path of after.keys()) {
    if (!isExpectedName(path)) continue;
    if (!before.has(path)) edited.push(path);
  }
  return { ok: edited.length === 0, edited };
}
