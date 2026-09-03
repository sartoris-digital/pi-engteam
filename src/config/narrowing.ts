import { ConfigError } from "./errors.js";
import { KINDS, type LayerName, type PolicyLevel, type RepoDefaults, type SandboxMode } from "./schema.js";

export const POLICY_RANK: Record<PolicyLevel, number> = { never: 0, elevated: 1, always: 2 };
export const SANDBOX_RANK: Record<SandboxMode, number> = { off: 0, "best-effort": 1, required: 2 };

export const SAFETY_KEYS = [
  "sandbox",
  "writeRoots",
  "riskPaths",
  "securityPaths",
  "exclusivePaths",
  "generatedDocPatterns",
  "maxDiffLines",
  "maxChangedFiles",
  "steering",
  "planApproval",
] as const;
export type SafetyKey = (typeof SAFETY_KEYS)[number];

export class NarrowingError extends ConfigError {
  readonly key: string;
  readonly layer: LayerName;

  constructor(key: string, layer: LayerName, detail: string) {
    super("narrowing", `config: layer "${layer}" may not loosen "${key}" (${detail})`, { keyPath: key });
    this.name = "NarrowingError";
    this.key = key;
    this.layer = layer;
  }
}

/**
 * Spec §2.1 narrowing rule. Policy keys (and sandbox, the operator's posture) narrow from the
 * committed layer on; generatedDocPatterns can never shrink; the remaining safety keys narrow at
 * layers 4 and 5 relative to whatever layer 3 left in effect.
 */
export function narrowedKeysFor(layer: LayerName): readonly SafetyKey[] {
  switch (layer) {
    case "builtin":
      return [];
    case "global":
      return ["generatedDocPatterns"];
    case "committed":
      return ["steering", "planApproval", "sandbox", "generatedDocPatterns"];
    case "overrides":
    case "local":
      return SAFETY_KEYS;
  }
}

/**
 * `lower` is the overlay a layer contributes; `upper` is the effective config before that layer.
 * Throws NarrowingError naming the key and the layer on the first loosening attempt.
 */
export function assertNarrowing(lower: RepoDefaults, upper: RepoDefaults, layer: LayerName): void {
  const keys = new Set<SafetyKey>(narrowedKeysFor(layer));

  if (keys.has("steering")) {
    guard("steering", layer, lower.steering, upper.steering, (prev, next) =>
      ordered("steering", layer, POLICY_RANK, prev, next),
    );
  }
  if (keys.has("planApproval")) {
    guard("planApproval", layer, lower.planApproval, upper.planApproval, (prev, next) =>
      ordered("planApproval", layer, POLICY_RANK, prev, next),
    );
  }
  if (keys.has("sandbox")) {
    guard("sandbox", layer, lower.sandbox, upper.sandbox, (prev, next) =>
      ordered("sandbox", layer, SANDBOX_RANK, prev, next),
    );
  }
  if (keys.has("maxDiffLines")) {
    guard("maxDiffLines", layer, lower.maxDiffLines, upper.maxDiffLines, (prev, next) =>
      atMost("maxDiffLines", layer, prev, next),
    );
  }
  if (keys.has("maxChangedFiles")) {
    guard("maxChangedFiles", layer, lower.maxChangedFiles, upper.maxChangedFiles, (prev, next) =>
      atMost("maxChangedFiles", layer, prev, next),
    );
  }
  for (const key of ["riskPaths", "securityPaths", "exclusivePaths", "generatedDocPatterns"] as const) {
    if (keys.has(key)) {
      guard(key, layer, lower[key], upper[key], (prev, next) => superset(key, layer, prev, next));
    }
  }
  if (keys.has("writeRoots") && lower.writeRoots !== undefined) {
    for (const kind of KINDS) {
      const key = `writeRoots.${kind}`;
      guard(key, layer, lower.writeRoots[kind], upper.writeRoots?.[kind], (prev, next) =>
        subset(key, layer, prev, next),
      );
    }
  }
}

/** Skips unset keys, rejects null, skips when the upper layer never set the key, else runs `check`. */
function guard<T>(
  key: string,
  layer: LayerName,
  next: T | null | undefined,
  prev: T | null | undefined,
  check: (prev: T, next: T) => void,
): void {
  if (next === undefined) return;
  if (next === null) throw new NarrowingError(key, layer, "safety keys cannot be deleted with null");
  if (prev === undefined || prev === null) return;
  check(prev, next);
}

function ordered<T extends string>(key: string, layer: LayerName, rank: Record<T, number>, prev: T, next: T): void {
  if (rank[next] < rank[prev]) throw new NarrowingError(key, layer, `${prev} → ${next}`);
}

function atMost(key: string, layer: LayerName, prev: number, next: number): void {
  if (next > prev) throw new NarrowingError(key, layer, `${prev} → ${next}`);
}

/** Lists that may only grow: every entry of `prev` must survive in `next`. */
function superset(key: string, layer: LayerName, prev: string[], next: string[]): void {
  const dropped = prev.find((entry) => !next.includes(entry));
  if (dropped !== undefined) throw new NarrowingError(key, layer, `drops ${JSON.stringify(dropped)}`);
}

/** Lists that may only shrink: `next` may not introduce an entry absent from `prev`. */
function subset(key: string, layer: LayerName, prev: string[], next: string[]): void {
  const added = next.find((entry) => !prev.includes(entry));
  if (added !== undefined) throw new NarrowingError(key, layer, `adds ${JSON.stringify(added)}`);
}
