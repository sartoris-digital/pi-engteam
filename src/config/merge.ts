import { isPlainObject, type JsonObject } from "./json.js";
import type { LayerName } from "./schema.js";

export interface ConfigLayer {
  name: LayerName;
  value: JsonObject;
  /** File the layer was read from; null for the built-in layer. */
  path: string | null;
}

export interface MergeResult {
  config: JsonObject;
  /** dotted leaf path → the layer that last set it. Arrays are leaves. Deleted keys have no entry. */
  provenance: Record<string, LayerName>;
}

export interface MergeOptions {
  /** Called before each layer is applied, with the merged config of all earlier layers. */
  beforeApply?: (layer: ConfigLayer, current: JsonObject) => void;
}

type Touch = (path: string, action: "set" | "delete") => void;

/**
 * Spec §2.1 merge rules, per key: plain objects merge recursively, arrays replace,
 * `null` deletes. Returns a new object; neither input is mutated or aliased.
 */
export function deepMerge(base: JsonObject, overlay: JsonObject, touch?: Touch, prefix = ""): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      touch?.(path, "delete");
      continue;
    }
    const current = out[key];
    if (isPlainObject(value)) {
      if (current !== undefined && !isPlainObject(current)) touch?.(path, "delete");
      out[key] = deepMerge(isPlainObject(current) ? current : {}, value, touch, path);
      continue;
    }
    if (isPlainObject(current)) touch?.(path, "delete");
    out[key] = Array.isArray(value) ? structuredClone(value) : value;
    touch?.(path, "set");
  }
  return out;
}

export function mergeLayers(layers: ConfigLayer[], opts: MergeOptions = {}): MergeResult {
  const provenance: Record<string, LayerName> = {};
  let config: JsonObject = {};
  for (const layer of layers) {
    opts.beforeApply?.(layer, config);
    config = deepMerge(config, layer.value, (path, action) => {
      if (action === "delete") {
        for (const key of Object.keys(provenance)) {
          if (key === path || key.startsWith(`${path}.`)) delete provenance[key];
        }
      } else {
        provenance[path] = layer.name;
      }
    });
  }
  return { config, provenance };
}
