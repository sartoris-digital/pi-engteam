import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { migrateConfig, migrateRepoFile } from "../config/migrate.js";
import {
  committedConfigPath,
  globalConfigPath,
  localConfigPath,
  readGlobal,
} from "../config/layers.js";
import type { FactoryConfig, RepoFile } from "../config/schema.js";
import type { SetupDiff } from "./interview.js";

async function writeAtomic(path: string, json: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export async function writeGlobalConfig(home: string, overlay: SetupDiff): Promise<string> {
  const existing = await readGlobal(home);
  const merged: FactoryConfig = migrateConfig({
    schemaVersion: 1,
    operator: { ...(existing.operator ?? {}), ...(overlay.operator ?? {}) },
    defaults: { ...(existing.defaults ?? {}), ...(overlay.defaults ?? {}) },
    repos: overlay.repos ?? existing.repos,
  });
  const path = globalConfigPath(home);
  await writeAtomic(path, merged);
  return path;
}

export async function writeRepoConfig(
  repo: string,
  diff: SetupDiff,
  opts: { local: boolean },
): Promise<string> {
  const path = opts.local ? localConfigPath(repo) : committedConfigPath(repo);
  const file: RepoFile = migrateRepoFile({ schemaVersion: 1, ...(diff.defaults ?? {}) });
  await writeAtomic(path, file);
  return path;
}
