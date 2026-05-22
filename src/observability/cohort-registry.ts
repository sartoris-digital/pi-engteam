// Phase E item E15 — bounded cohort registry. Maps high-cardinality
// runtime tuples (provider × modelId × accountFingerprint ×
// piVersion) to a bounded `cohort` label suitable for export.
//
// - Up to 256 cohort buckets, allocated lazily as new tuples
//   appear.
// - Persistent `(tuple → cohort id)` mapping at
//   `<configDir>/cohort-registry.json` for cross-process
//   consistency.
// - Overflow tail-cohorts as `cohort=overflow` with a paging
//   metric. Per round 11 MED #3, overflow is a HARD ramp blocker
//   (callers consult `isOverflowing()` before advancing a feature
//   ramp).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type CohortTuple = {
  provider: string;
  modelId: string;
  accountFingerprint: string;
  piVersion: string;
};

export type CohortEntry = {
  id: string;             // short hex label
  tuple: CohortTuple;
  firstSeenTs: string;
};

export type CohortRegistryState = {
  schemaVersion: 1;
  maxBuckets: number;
  entries: Record<string, CohortEntry>; // keyed by tupleKey
};

export const OVERFLOW_COHORT = "overflow";

function tupleKey(t: CohortTuple): string {
  return [t.provider, t.modelId, t.accountFingerprint, t.piVersion].join("|");
}

export class CohortRegistry {
  private state: CohortRegistryState;
  private readonly path: string;

  constructor(configDir: string, opts?: { maxBuckets?: number }) {
    this.path = join(configDir, "cohort-registry.json");
    this.state = this.load(opts?.maxBuckets ?? 256);
  }

  /**
   * Return the cohort id for a tuple. Allocates a new id if the
   * tuple hasn't been seen AND there's room. Returns
   * `OVERFLOW_COHORT` otherwise.
   */
  cohortFor(tuple: CohortTuple): string {
    const key = tupleKey(tuple);
    const existing = this.state.entries[key];
    if (existing) return existing.id;
    if (Object.keys(this.state.entries).length >= this.state.maxBuckets) {
      return OVERFLOW_COHORT;
    }
    const id = this.nextId();
    this.state.entries[key] = {
      id,
      tuple,
      firstSeenTs: new Date().toISOString(),
    };
    this.persist();
    return id;
  }

  /** True when overflow has been reached — used by the rollout
   *  controller as a HARD ramp blocker. */
  isOverflowing(): boolean {
    return Object.keys(this.state.entries).length >= this.state.maxBuckets;
  }

  /** Diagnostic — how many tuples we've allocated buckets for. */
  size(): number {
    return Object.keys(this.state.entries).length;
  }

  /** List every (tuple, cohort id) — used by offline rollup. */
  list(): CohortEntry[] {
    return Object.values(this.state.entries);
  }

  private nextId(): string {
    // Stable ordering: derive id from the count so it's
    // reproducible across loads when entries are inserted in the
    // same order. Padded to 3 hex chars (covers 4096 > 256
    // capacity).
    const n = Object.keys(this.state.entries).length;
    return `c${n.toString(16).padStart(3, "0")}`;
  }

  private load(maxBuckets: number): CohortRegistryState {
    if (!existsSync(this.path)) {
      return { schemaVersion: 1, maxBuckets, entries: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed?.schemaVersion === 1) {
        return {
          schemaVersion: 1,
          maxBuckets: parsed.maxBuckets ?? maxBuckets,
          entries: parsed.entries ?? {},
        };
      }
    } catch { /* corrupted — start fresh */ }
    return { schemaVersion: 1, maxBuckets, entries: {} };
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = this.path + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch { /* best-effort */ }
  }
}
