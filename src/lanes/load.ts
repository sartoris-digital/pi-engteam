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
