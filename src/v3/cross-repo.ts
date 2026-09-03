import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { v3Enabled, type V3HostConfig } from "./dispatch.js";

export interface SharedArtifact {
  name: string;
  version: number;
  fromRepo: string;
  payload?: unknown;
}

export interface ImportedEntry {
  name: string;
  version: number;
  state: "probationary";
  source: "shared";
  fromRepo: string;
}

export interface RepoShadowStats {
  shadowAgree: number;
}

function parseNameVersion(nameVersion: string): { name: string; version: number } {
  const at = nameVersion.lastIndexOf("@");
  if (at <= 0) throw new Error(`cross-repo: invalid name@version ${JSON.stringify(nameVersion)}`);
  const name = nameVersion.slice(0, at);
  const version = Number(nameVersion.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`cross-repo: invalid version in ${JSON.stringify(nameVersion)}`);
  }
  return { name, version };
}

function repoSlug(repo: string): string {
  return repo.replaceAll("/", "__");
}

export function sharedDir(home: string): string {
  return join(home, "runs", "_factory", "codify", "shared");
}

export function sharedArtifactPath(home: string, nameVersion: string): string {
  return join(sharedDir(home), `${nameVersion}.json`);
}

export function importedRegistryPath(home: string, toRepo: string): string {
  return join(home, "codified", "repos", repoSlug(toRepo), "imported.json");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export async function shareToGlobal(opts: {
  home: string;
  nameVersion: string;
  fromRepo: string;
  artifact: SharedArtifact;
}): Promise<{ path: string }> {
  parseNameVersion(opts.nameVersion);
  const path = sharedArtifactPath(opts.home, opts.nameVersion);
  const artifact: SharedArtifact = {
    ...opts.artifact,
    fromRepo: opts.fromRepo,
  };
  await writeJsonAtomic(path, artifact);
  return { path };
}

export async function loadImported(home: string, toRepo: string): Promise<Record<string, ImportedEntry>> {
  try {
    const raw = JSON.parse(await readFile(importedRegistryPath(home, toRepo), "utf8")) as {
      entries?: Record<string, ImportedEntry>;
    };
    return raw.entries ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function importToRepo(opts: {
  home: string;
  nameVersion: string;
  toRepo: string;
  cfg?: V3HostConfig;
}): Promise<{ entry: ImportedEntry }> {
  void opts.cfg;
  const { name, version } = parseNameVersion(opts.nameVersion);
  const path = sharedArtifactPath(opts.home, opts.nameVersion);
  let artifact: SharedArtifact;
  try {
    artifact = JSON.parse(await readFile(path, "utf8")) as SharedArtifact;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`cross-repo: shared artifact ${opts.nameVersion} not found`);
    }
    throw err;
  }
  const entry: ImportedEntry = {
    name,
    version,
    state: "probationary",
    source: "shared",
    fromRepo: artifact.fromRepo,
  };
  const current = await loadImported(opts.home, opts.toRepo);
  current[opts.nameVersion] = entry;
  await writeJsonAtomic(importedRegistryPath(opts.home, opts.toRepo), { entries: current });
  return { entry };
}

export function exactDispatchAllowed(
  cfg: V3HostConfig,
  _toRepo: string,
  _nameVersion: string,
  repoStats: RepoShadowStats,
): boolean {
  if (!v3Enabled(cfg, "crossRepoTools")) return false;
  const need = cfg.codify?.shadowAgreeToActivate ?? 2;
  return repoStats.shadowAgree >= need;
}
