import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { LaneSchemaError, assertLaneLayerFile, type LaneDef, type LaneLayerFile, type LanePatch, type StageDef } from "./schema.js";

export class LaneLoadError extends Error {
  readonly path: string | undefined;
  constructor(message: string, path?: string) {
    super(message);
    this.name = "LaneLoadError";
    this.path = path;
  }
}

export interface LaneLayer {
  path: string;
  file: LaneLayerFile;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export async function loadLaneLayers(paths: string[]): Promise<LaneLayer[]> {
  const out: LaneLayer[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if (isEnoent(err)) continue;
      throw new LaneLoadError(`cannot read lane file: ${(err as Error).message}`, path);
    }
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (err) {
      throw new LaneLoadError(`YAML parse error: ${(err as Error).message}`, path);
    }
    try {
      out.push({ path, file: assertLaneLayerFile(raw, path) });
    } catch (err) {
      const msg = err instanceof LaneSchemaError ? err.message : (err as Error).message;
      throw new LaneLoadError(msg, path);
    }
  }
  return out;
}

function lastDefined<T>(items: T[], read: (item: T) => string | undefined): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const value = read(items[i]!);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function mergeStages(base: StageDef[], overlay?: StageDef[]): StageDef[] {
  if (overlay === undefined) return base.map((s) => ({ ...s }));
  const stages = base.map((s) => ({ ...s }));
  for (const patch of overlay) {
    const idx = stages.findIndex((s) => s.name === patch.name);
    if (patch.remove === true) {
      if (idx >= 0) stages.splice(idx, 1);
      continue;
    }
    const { remove: _r, insertAfter, ...rest } = patch;
    if (idx >= 0) {
      stages[idx] = { ...stages[idx], ...rest };
      continue;
    }
    const afterIdx = insertAfter ? stages.findIndex((s) => s.name === insertAfter) : -1;
    if (afterIdx >= 0) stages.splice(afterIdx + 1, 0, { ...rest });
    else stages.push({ ...rest });
  }
  return stages;
}

function mergeMatch(base: LaneDef["match"] | undefined, patch: LanePatch["match"]): LaneDef["match"] {
  return { ...(base ?? {}), ...(patch ?? {}) };
}

function mergeBudget(base: LaneDef["budget"] | undefined, patch: LanePatch["budget"]): LaneDef["budget"] {
  return { fixRounds: 1, maxWallSeconds: 0, maxCostUsd: 0, ...(base ?? {}), ...(patch ?? {}) };
}

function mergeLanePatch(base: Partial<LaneDef>, patch: LanePatch): Partial<LaneDef> {
  return {
    ...base,
    ...(patch.class !== undefined ? { class: patch.class } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.gateless !== undefined ? { gateless: patch.gateless } : {}),
    ...(patch.onExhausted !== undefined ? { onExhausted: patch.onExhausted } : {}),
    ...(patch.extends !== undefined ? { extends: patch.extends } : {}),
    ...(patch.fusion !== undefined ? { fusion: patch.fusion } : {}),
    match: mergeMatch(base.match, patch.match),
    budget: mergeBudget(base.budget, patch.budget),
    publish: { ...(base.publish ?? {}), ...(patch.publish ?? {}) },
    stages: mergeStages(base.stages ?? [], patch.stages),
  };
}

function assertComplete(name: string, lane: Partial<LaneDef>): LaneDef {
  if (lane.match === undefined || lane.priority === undefined || lane.budget === undefined || lane.stages === undefined) {
    throw new LaneLoadError(`lane ${name} is missing match, priority, budget or stages after merge`);
  }
  return lane as LaneDef;
}

export function mergeLanes(files: LaneLayerFile[]): Record<string, LaneDef> {
  const patches = new Map<string, LanePatch[]>();
  for (const file of files) {
    for (const [name, patch] of Object.entries(file.lanes)) {
      const list = patches.get(name) ?? [];
      list.push(patch);
      patches.set(name, list);
    }
  }
  const resolved = new Map<string, LaneDef>();
  const visiting = new Set<string>();

  const resolve = (name: string): LaneDef => {
    const hit = resolved.get(name);
    if (hit) return hit;
    if (visiting.has(name)) throw new LaneLoadError(`extends cycle at ${name}`);
    const list = patches.get(name);
    if (list === undefined) throw new LaneLoadError(`lane ${name} is referenced but never defined`);
    visiting.add(name);
    const parentName = lastDefined(list, (p) => p.extends);
    let current: Partial<LaneDef> = parentName && parentName !== name ? structuredClone(resolve(parentName)) : {};
    if (parentName) current = { ...current, extends: parentName };
    for (const patch of list) current = mergeLanePatch(current, patch);
    visiting.delete(name);
    const complete = assertComplete(name, current);
    resolved.set(name, complete);
    return complete;
  };

  for (const name of patches.keys()) resolve(name);
  return Object.fromEntries(resolved);
}
