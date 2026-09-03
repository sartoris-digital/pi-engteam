import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { CATALOG, type Catalog } from "./catalog.js";
import { LaneInvariantError, checkAllInvariants } from "./invariants.js";
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
  const acc: Record<string, LaneDef> = {};

  for (const file of files) {
    const names = Object.keys(file.lanes);
    const existing = names.filter((name) => acc[name] !== undefined);
    const created = names.filter((name) => acc[name] === undefined);

    for (const name of existing) {
      acc[name] = assertComplete(name, mergeLanePatch(acc[name]!, file.lanes[name]!));
    }

    const visiting = new Set<string>();
    const resolveNew = (name: string): LaneDef => {
      const hit = acc[name];
      if (hit !== undefined) return hit;
      if (visiting.has(name)) throw new LaneLoadError(`extends cycle at ${name}`);
      const patch = file.lanes[name];
      if (patch === undefined) throw new LaneLoadError(`lane ${name} is referenced but never defined`);
      visiting.add(name);
      const parentName = patch.extends;
      let current: Partial<LaneDef> = {};
      if (parentName && parentName !== name) {
        current = structuredClone(resolveNew(parentName));
        current = { ...current, extends: parentName };
      }
      const complete = assertComplete(name, mergeLanePatch(current, patch));
      acc[name] = complete;
      visiting.delete(name);
      return complete;
    };

    for (const name of created) resolveNew(name);
  }

  return acc;
}

export const BUILTIN_LANES_PATH = fileURLToPath(new URL("../assets/lanes.yaml", import.meta.url));
export const BUILTIN_POLICY_PATH = fileURLToPath(new URL("../assets/policy.yaml", import.meta.url));

/** Layer 1 alone: the shipped lanes, merged and schema-validated. */
export async function loadBuiltinLanes(): Promise<Record<string, LaneDef>> {
  const layers = await loadLaneLayers([BUILTIN_LANES_PATH]);
  const builtin = layers[0];
  if (builtin === undefined) throw new LaneLoadError(`built-in lane file missing: ${BUILTIN_LANES_PATH}`, BUILTIN_LANES_PATH);
  return mergeLanes([builtin.file]);
}

/**
 * Five-layer load (spec §4.2): paths[0] is the built-in file, the rest are optional override layers
 * in precedence order. Every effective lane must pass class, override-tightening and catalog invariants.
 */
export async function loadEffectiveLanes(paths: string[], catalog: Catalog = CATALOG): Promise<Record<string, LaneDef>> {
  const layers = await loadLaneLayers(paths);
  const first = layers[0];
  if (first === undefined || first.path !== paths[0]) {
    throw new LaneLoadError(`built-in lane file missing: ${paths[0] ?? "(no paths given)"}`, paths[0]);
  }
  const builtins = mergeLanes([first.file]);
  const effective = mergeLanes(layers.map((layer) => layer.file));
  const errors = checkAllInvariants(builtins, effective, catalog);
  if (errors.length > 0) throw new LaneInvariantError(errors);
  return effective;
}
