import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { factoryHome } from "../home.js";
import { ConfigError } from "./errors.js";
import { isPlainObject, type JsonObject } from "./json.js";
import { migrateConfig, migrateRepoFile } from "./migrate.js";
import type { FactoryConfig, LayerName, RepoDefaults, RepoEntry } from "./schema.js";

export type { LayerName };

export function globalConfigPath(home: string): string {
  return path.join(home, "factory.json");
}

export function committedConfigPath(repo: string): string {
  return path.join(repo, ".pi", "factory.json");
}

export function localConfigPath(repo: string): string {
  return path.join(repo, ".pi", "factory.local.json");
}

/** Reads a JSON file that must hold an object. Missing file → null; malformed → ConfigError("parse"). */
export async function readJsonObject(file: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError("parse", `${file}: invalid JSON: ${(err as Error).message}`, { file });
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError("parse", `${file}: expected a JSON object at the top level`, { file });
  }
  return parsed;
}

/** Layer 2. `home` defaults to factoryHome() (honours PI_SDLC_HOME). Missing file → `{ schemaVersion: 1 }`. */
export async function readGlobal(home: string = factoryHome()): Promise<FactoryConfig> {
  const file = globalConfigPath(home);
  const raw = await readJsonObject(file);
  const empty: FactoryConfig = { schemaVersion: 1 };
  return raw === null ? empty : migrateConfig(raw, file);
}

/** Layer 3. v0 reads the working tree; v1 reads `git show origin/<base>:.pi/factory.json` (spec §2.1 Trust). */
export async function readCommitted(repo: string): Promise<RepoDefaults> {
  return readRepoFile(committedConfigPath(repo));
}

/** Layer 5. Gitignored operator overlay for this machine only. */
export async function readLocal(repo: string): Promise<RepoDefaults> {
  return readRepoFile(localConfigPath(repo));
}

async function readRepoFile(file: string): Promise<RepoDefaults> {
  const raw = await readJsonObject(file);
  if (raw === null) return {};
  const { schemaVersion: _version, ...overlay } = migrateRepoFile(raw, file);
  return overlay;
}

/** `~` and `~/x` expand against `home`; anything else is returned unchanged. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The repos[] entry whose path resolves to `repo` (after ~ expansion, symlinks and trailing slashes). */
export function findRepoEntry(global: FactoryConfig, repo: string): RepoEntry | undefined {
  const target = canonicalPath(repo);
  return (global.repos ?? []).find((entry) => canonicalPath(expandHome(entry.path)) === target);
}

/** Layer 4. `{}` when the repo is not registered or has no overrides. */
export function readRepoOverrides(global: FactoryConfig, repo: string): RepoDefaults {
  return findRepoEntry(global, repo)?.overrides ?? {};
}
