// Phase B item 14 + round 5 MED #1 + round 6 MED #1 — single
// resolution surface for the activity-stream on-disk layout. Tail,
// replay, SSE, and Layer-A protection all import from here so the
// path can move without spraying string concatenations.
import { join } from "path";

export type ActivityPaths = {
  dir: string;
  jsonl: string;
  lock: string;
  seq: string;
  legacyMirror: string;
};

/**
 * Resolve all activity-related file paths for a given runId. Storage
 * lives under `<runsDir>/_activity/<runId>/` — ISOLATED from the
 * per-run state dir so `_activity` quota exhaustion never refuses
 * new core runs (round 4 MED #4 + round 11 HIGH #3).
 *
 * The `legacyMirror` path is `<runsDir>/<runId>/agent-activity.jsonl`
 * — the byte-compatible path the 2.0.x CLI hardcoded. When the
 * mirror feature is on, the queue ALSO writes to this exact location
 * so old CLIs can still tail.
 */
export function getActivityPaths(runsDir: string, runId: string): ActivityPaths {
  const dir = join(runsDir, "_activity", runId);
  return {
    dir,
    jsonl: join(dir, "agent-activity.jsonl"),
    lock: join(dir, ".lock"),
    seq: join(dir, "_seq.json"),
    legacyMirror: join(runsDir, runId, "agent-activity.jsonl"),
  };
}
