import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join, basename } from "path";

export const SCHEMA_VERSION = "2.1.0";
export const LEGACY_SCHEMA_VERSION = "2.0.x";

// Artifact classification
export type ArtifactClass = "byte-compatible" | "side-car";

export type ArtifactDescriptor = {
  path: string; // relative to runDir
  class: ArtifactClass;
  readableBy: string[]; // e.g. ["2.0.x", "2.1+"]
};

// Canonical artifact registry
export const ARTIFACT_REGISTRY: ArtifactDescriptor[] = [
  { path: "state.json",             class: "byte-compatible", readableBy: ["2.0.x", "2.1+"] },
  { path: "events.jsonl",           class: "byte-compatible", readableBy: ["2.0.x", "2.1+"] },
  { path: "state.v2.json",          class: "side-car",        readableBy: ["2.1+"] },
  { path: "_verdicts/",             class: "side-car",        readableBy: ["2.1+"] },
  { path: "_activity/",             class: "side-car",        readableBy: ["2.1+"] },
  { path: "feature-decisions.json", class: "side-car",        readableBy: ["2.1+"] },
];

/**
 * Check if a runDir is safe to downgrade to target version.
 * Currently supports checking against "2.0.x" compatibility.
 */
export function rollbackReadiness(
  runDir: string,
  targetVersion: string,
): {
  runId: string;
  safe: boolean;
  incompatibleArtifacts: string[];
  recommendation: "finish" | "cancel" | "migrate-down";
} {
  const runId = basename(runDir);

  if (targetVersion !== LEGACY_SCHEMA_VERSION) {
    // Only 2.0.x downgrade is supported; treat unknown targets as safe no-ops
    return { runId, safe: true, incompatibleArtifacts: [], recommendation: "migrate-down" };
  }

  const incompatibleArtifacts: string[] = [];

  for (const descriptor of ARTIFACT_REGISTRY) {
    if (descriptor.class !== "side-car") continue;
    if (descriptor.readableBy.includes(targetVersion)) continue;

    const fullPath = join(runDir, descriptor.path);
    if (existsSync(fullPath)) {
      incompatibleArtifacts.push(descriptor.path);
    }
  }

  const safe = incompatibleArtifacts.length === 0;

  return {
    runId,
    safe,
    incompatibleArtifacts,
    recommendation: "migrate-down",
  };
}

/**
 * Remove 2.1+ side-cars from a runDir, making it 2.0.x-compatible.
 */
export function migrateDown(
  runDir: string,
  opts?: { dryRun?: boolean },
): {
  removed: string[];
  preserved: string[];
  errors: string[];
} {
  const dryRun = opts?.dryRun ?? false;
  const removed: string[] = [];
  const preserved: string[] = [];
  const errors: string[] = [];

  for (const descriptor of ARTIFACT_REGISTRY) {
    const fullPath = join(runDir, descriptor.path);

    if (!existsSync(fullPath)) continue;

    if (descriptor.class === "side-car") {
      if (!dryRun) {
        try {
          rmSync(fullPath, { recursive: true, force: true });
          removed.push(descriptor.path);
        } catch (err) {
          errors.push(
            `Failed to remove ${descriptor.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        removed.push(descriptor.path);
      }
    } else {
      preserved.push(descriptor.path);
    }
  }

  return { removed, preserved, errors };
}

/**
 * Read the status field from a run's state.json without fully parsing.
 * Returns null if the file is missing or unreadable.
 */
export function readRunStatus(runDir: string): string | null {
  const stateFile = join(runDir, "state.json");
  if (!existsSync(stateFile)) return null;
  try {
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed["status"] === "string" ? (parsed["status"] as string) : null;
  } catch {
    return null;
  }
}

/**
 * List all run directories under runsDir.
 */
export function listRunDirs(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(runsDir, d.name));
  } catch {
    return [];
  }
}
