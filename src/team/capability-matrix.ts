// Phase 0 — capability matrix. Reads CapabilityBundle JSONs from the
// per-user cache and from bundled baselines, validates against the
// schema, and answers `getCapabilities({...lookupKey})` for Phase A
// gating. Round 9 LOW bounded retention + GC is enforced here.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import { Value } from "@sinclair/typebox/value";
import { CapabilityBundle, type CapabilityLookup } from "./capability-schema.js";

export type CapabilityMode = "observe" | "warn" | "enforce";

export type LookupKey = {
  provider: string;
  modelId: string;
  accountFingerprint: string;
  piVersion: string;
  piBuildHash: string;
  protocolVersion: string;
  runtimeFlags: string[];
};

export type MatrixConfig = {
  // Where probe-written bundles live. Defaults to
  // ~/.pi/engineering-team/capabilities/.
  cacheDir?: string;
  // Where shipped baseline bundles live. Defaults to the dist-relative
  // dir populated by `postbuild`. Tests inject a tmpdir.
  baselineDir?: string;
  // GC tuning.
  maxBundlesPerProvider?: number;
  maxBytesPerProvider?: number;
  bundleTtlDays?: number;
  // Mode determines whether wildcard baselines satisfy `enforce`
  // (they never do) or just `warn`/`observe`.
  mode?: CapabilityMode;
};

export const DEFAULT_MATRIX_CONFIG: Required<Omit<MatrixConfig, "cacheDir" | "baselineDir">> = {
  maxBundlesPerProvider: 100,
  maxBytesPerProvider: 256 * 1024 * 1024,
  bundleTtlDays: 90,
  mode: "warn",
};

function defaultCacheDir(): string {
  return join(homedir(), ".pi", "engineering-team", "capabilities");
}

function defaultBaselineDir(): string {
  // dist/assets/capability-baselines/ is populated by `postbuild`
  // copying src/assets/. During development the matrix falls back to
  // the source tree.
  const here = new URL(import.meta.url).pathname;
  const distAssets = join(dirname(here), "..", "assets", "capability-baselines");
  if (existsSync(distAssets)) return distAssets;
  const srcAssets = join(dirname(here), "..", "..", "src", "assets", "capability-baselines");
  return srcAssets;
}

export class CapabilityMatrix {
  private readonly config: Required<MatrixConfig>;

  constructor(config: MatrixConfig = {}) {
    this.config = {
      cacheDir: config.cacheDir ?? defaultCacheDir(),
      baselineDir: config.baselineDir ?? defaultBaselineDir(),
      maxBundlesPerProvider: config.maxBundlesPerProvider ?? DEFAULT_MATRIX_CONFIG.maxBundlesPerProvider,
      maxBytesPerProvider: config.maxBytesPerProvider ?? DEFAULT_MATRIX_CONFIG.maxBytesPerProvider,
      bundleTtlDays: config.bundleTtlDays ?? DEFAULT_MATRIX_CONFIG.bundleTtlDays,
      mode: config.mode ?? DEFAULT_MATRIX_CONFIG.mode,
    };
  }

  /**
   * Look up the best bundle for the given runtime tuple. Returns
   * undefined when no bundle matches (caller decides whether to
   * fail-fast in `enforce`, warn in `warn`, or proceed silently in
   * `observe`).
   *
   * Match order:
   *   1. Probed bundle with full-tuple match on the canonical
   *      provenance fields.
   *   2. Probed bundle that matches provider+piVersion+piBuildHash
   *      (model/account/flag drift; still recent runtime).
   *   3. Shipped baseline bundle for the provider (wildcards
   *      allowed only when not in `enforce`).
   *   4. undefined.
   */
  getCapabilities(key: LookupKey): CapabilityLookup | undefined {
    const probed = this.findProbedBundle(key);
    if (probed) return probed;

    if (this.config.mode === "enforce") {
      // In enforce, baselines (which carry wildcards) are not
      // usable; the caller fails fast.
      return undefined;
    }

    const baseline = this.findBaselineBundle(key.provider);
    return baseline;
  }

  /**
   * Validate + load all probed bundles from the cache dir for a
   * given provider, returning them sorted by `probeTs` desc.
   */
  loadProbedBundles(provider: string): CapabilityBundle[] {
    const dir = join(this.config.cacheDir, provider);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const bundles: CapabilityBundle[] = [];
    for (const f of files) {
      const path = join(dir, f);
      try {
        const text = readFileSync(path, "utf8");
        const parsed = JSON.parse(text);
        if (!Value.Check(CapabilityBundle, parsed)) {
          // Refuse hand-edited / hash-broken / out-of-schema files.
          continue;
        }
        // Verify the embedded bundleHash matches the file's content
        // hash with the bundleHash field zeroed out.
        if (!this.verifyBundleHash(parsed)) continue;
        bundles.push(parsed);
      } catch {
        // Skip unreadable / malformed files; GC will eventually
        // remove them.
      }
    }
    bundles.sort((a, b) => b.provenance.probeTs.localeCompare(a.provenance.probeTs));
    return bundles;
  }

  /**
   * Garbage-collect bundles for one provider per the documented
   * retention policy:
   *   - Keep most-recent bundle per FULL runtimeFingerprint tuple
   *     (round 15 MED #2).
   *   - Keep N=10 fleet-wide most-recent regardless of fingerprint.
   *   - Drop bundles older than `bundleTtlDays`.
   *   - Cap by `maxBundlesPerProvider` and `maxBytesPerProvider`.
   * Returns the list of paths that were removed.
   */
  gc(provider: string, pinnedFingerprints: string[] = []): string[] {
    const dir = join(this.config.cacheDir, provider);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dir, f));
    const entries = files
      .map((p) => {
        try {
          const text = readFileSync(p, "utf8");
          const parsed = JSON.parse(text);
          if (!Value.Check(CapabilityBundle, parsed)) return null;
          const st = statSync(p);
          return { path: p, bundle: parsed as CapabilityBundle, size: st.size };
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; bundle: CapabilityBundle; size: number } => e !== null);

    if (entries.length === 0) return [];

    // Sort newest first.
    entries.sort((a, b) => b.bundle.provenance.probeTs.localeCompare(a.bundle.provenance.probeTs));

    const keep = new Set<string>();
    const seenFingerprints = new Set<string>();
    const now = Date.now();
    const ttlMs = this.config.bundleTtlDays * 24 * 60 * 60 * 1000;

    // Pass 1: keep most-recent per full fingerprint.
    for (const e of entries) {
      const fp = this.fingerprintOf(e.bundle);
      if (!seenFingerprints.has(fp)) {
        seenFingerprints.add(fp);
        keep.add(e.path);
      }
    }
    // Pass 2: keep pinned fingerprints regardless of age/cap.
    const pinned = new Set(pinnedFingerprints);
    for (const e of entries) {
      if (pinned.has(this.fingerprintOf(e.bundle))) keep.add(e.path);
    }
    // Pass 3: keep top-10 fleet-wide most-recent (union with pass-1
    // results; entries already sorted newest-first).
    const FLEET_WIDE_RETENTION = 10;
    for (let i = 0; i < entries.length && i < FLEET_WIDE_RETENTION; i++) {
      keep.add(entries[i].path);
    }

    // Prune by TTL (unless pinned).
    const removed: string[] = [];
    for (const e of entries) {
      const ageMs = now - new Date(e.bundle.provenance.probeTs).getTime();
      if (ageMs > ttlMs && !pinned.has(this.fingerprintOf(e.bundle))) {
        if (keep.has(e.path)) keep.delete(e.path);
      }
    }
    // Final pass: cap by count + bytes (oldest unpinned first).
    let count = 0;
    let bytes = 0;
    for (const e of entries) {
      if (!keep.has(e.path)) continue;
      count++;
      bytes += e.size;
      if (count > this.config.maxBundlesPerProvider || bytes > this.config.maxBytesPerProvider) {
        if (!pinned.has(this.fingerprintOf(e.bundle))) keep.delete(e.path);
      }
    }
    for (const e of entries) {
      if (!keep.has(e.path)) {
        try {
          unlinkSync(e.path);
          removed.push(e.path);
        } catch {
          // best-effort
        }
      }
    }
    return removed;
  }

  /**
   * Compute the bundle hash used for tamper detection — sha256 of
   * the canonical JSON with `provenance.probeBundleHash` zeroed.
   */
  static computeBundleHash(bundle: CapabilityBundle): string {
    const cleared: CapabilityBundle = {
      ...bundle,
      provenance: { ...bundle.provenance, probeBundleHash: "" },
    };
    const canonical = JSON.stringify(cleared, Object.keys(cleared).sort());
    return createHash("sha256").update(canonical).digest("hex");
  }

  private verifyBundleHash(bundle: CapabilityBundle): boolean {
    // Baseline bundles ship with hash="baseline" — accept that
    // exact sentinel rather than computing a real hash.
    if (bundle.baselineOnly && bundle.provenance.probeBundleHash === "baseline") return true;
    const expected = CapabilityMatrix.computeBundleHash(bundle);
    return expected === bundle.provenance.probeBundleHash;
  }

  /**
   * Persist a probed bundle to the cache dir, populating the
   * bundleHash field if not already set.
   */
  writeBundle(bundle: CapabilityBundle): string {
    const finalBundle: CapabilityBundle = {
      ...bundle,
      provenance: {
        ...bundle.provenance,
        probeBundleHash: bundle.provenance.probeBundleHash || CapabilityMatrix.computeBundleHash(bundle),
      },
    };
    if (!Value.Check(CapabilityBundle, finalBundle)) {
      const errs: string[] = [];
      for (const e of Value.Errors(CapabilityBundle, finalBundle)) {
        errs.push(`${e.path}: ${e.message}`);
        if (errs.length >= 5) break;
      }
      throw new Error(`Refusing to write bundle that does not match CapabilityBundle schema: ${errs.join("; ")}`);
    }
    const dir = join(this.config.cacheDir, finalBundle.provenance.provider);
    mkdirSync(dir, { recursive: true });
    const fname = `${finalBundle.provenance.piVersion}-${finalBundle.provenance.piBuildHash}-${finalBundle.provenance.modelId}-${finalBundle.provenance.probeTs.replace(/[:.]/g, "-")}.json`;
    const out = join(dir, fname);
    // Use writeFileSync directly so we can verify the bundleHash field
    // round-trips. Atomic write-temp-rename to avoid torn files.
    const tmp = `${out}.tmp`;
    const text = JSON.stringify(finalBundle, null, 2);
    const fs = require("fs") as typeof import("fs");
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, out);
    return out;
  }

  private findProbedBundle(key: LookupKey): CapabilityLookup | undefined {
    const bundles = this.loadProbedBundles(key.provider);
    if (bundles.length === 0) return undefined;
    // Pass 1: full-tuple match.
    for (const b of bundles) {
      if (this.matchFull(b, key)) {
        return {
          bundle: b,
          source: "probed",
          age: { probeTs: b.provenance.probeTs, ageDays: this.ageDays(b) },
          matchedByWildcard: false,
        };
      }
    }
    // Pass 2: relaxed match (provider + piVersion + piBuildHash).
    for (const b of bundles) {
      if (
        b.provenance.provider === key.provider &&
        b.provenance.piVersion === key.piVersion &&
        b.provenance.piBuildHash === key.piBuildHash
      ) {
        return {
          bundle: b,
          source: "probed",
          age: { probeTs: b.provenance.probeTs, ageDays: this.ageDays(b) },
          matchedByWildcard: true,
        };
      }
    }
    return undefined;
  }

  private findBaselineBundle(provider: string): CapabilityLookup | undefined {
    const dir = this.config.baselineDir;
    if (!existsSync(dir)) return undefined;
    const path = join(dir, `${provider}-baseline.json`);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!Value.Check(CapabilityBundle, parsed)) return undefined;
      if (!parsed.baselineOnly) return undefined;
      return {
        bundle: parsed,
        source: "baseline",
        age: { probeTs: parsed.provenance.probeTs, ageDays: this.ageDays(parsed) },
        matchedByWildcard: true,
      };
    } catch {
      return undefined;
    }
  }

  private matchFull(b: CapabilityBundle, key: LookupKey): boolean {
    const p = b.provenance;
    return (
      p.provider === key.provider &&
      p.modelId === key.modelId &&
      p.accountFingerprint === key.accountFingerprint &&
      p.piVersion === key.piVersion &&
      p.piBuildHash === key.piBuildHash &&
      p.protocolVersion === key.protocolVersion &&
      this.flagsEqual(p.runtimeFlags, key.runtimeFlags)
    );
  }

  private flagsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  }

  private fingerprintOf(b: CapabilityBundle): string {
    const p = b.provenance;
    return [
      p.provider,
      p.modelId,
      p.accountFingerprint,
      p.piVersion,
      p.piBuildHash,
      p.protocolVersion,
      [...p.runtimeFlags].sort().join(","),
    ].join("|");
  }

  private ageDays(b: CapabilityBundle): number {
    const now = Date.now();
    const t = new Date(b.provenance.probeTs).getTime();
    return Math.floor((now - t) / (24 * 60 * 60 * 1000));
  }
}
