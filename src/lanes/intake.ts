import { matchesAny } from "../gate/glob.js";
import type { Brief } from "../intake/brief-schema.js";
import { LaneInvariantError, matchesOverlap } from "./invariants.js";
import { LaneLoadError } from "./load.js";
import type { LaneDef, LaneMatch } from "./schema.js";

function laneMatches(match: LaneMatch, brief: Brief, labels: string[]): boolean {
  if (match.kind !== undefined && match.kind !== brief.kind) return false;
  if (match.tier !== undefined && match.tier !== brief.tier) return false;
  if (match.size !== undefined && match.size !== brief.size) return false;
  if (match.labels !== undefined && match.labels.length > 0) {
    if (!match.labels.some((l) => labels.includes(l))) return false;
  }
  if (match.flags !== undefined && match.flags.length > 0) {
    if (!match.flags.some((f) => (brief.flags as string[]).includes(f))) return false;
  }
  if (match.trigger !== undefined && match.trigger.length > 0) {
    const hit = match.trigger.some((t) => labels.includes(t) || labels.includes(`factory:lane=${t}`));
    if (!hit) return false;
  }
  if (match.likelyPaths !== undefined && match.likelyPaths.length > 0) {
    if (!brief.likelyPaths.some((p) => matchesAny(p, match.likelyPaths ?? []))) return false;
  }
  return true;
}

function assertNoEqualPriorityOverlap(lanes: Record<string, LaneDef>): void {
  const names = Object.keys(lanes);
  const errors = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = lanes[names[i]!]!;
      const b = lanes[names[j]!]!;
      if (a.priority === b.priority && matchesOverlap(a.match, b.match)) {
        errors.push({ lane: names[i]!, rule: "match-overlap", detail: names[j] });
      }
    }
  }
  if (errors.length > 0) throw new LaneInvariantError(errors);
}

/**
 * First match in descending priority. Forced `--lane` / `factory:lane=` wins.
 * Equal-priority overlapping match is a load error (matchesOverlap).
 */
export function selectLane(
  lanes: Record<string, LaneDef>,
  brief: Brief,
  labels: string[],
  forced?: string,
): string {
  assertNoEqualPriorityOverlap(lanes);
  if (forced !== undefined && forced.length > 0) {
    if (lanes[forced] === undefined) throw new LaneLoadError(`forced lane ${forced} is not defined`);
    return forced;
  }
  const ranked = Object.entries(lanes).sort((a, b) => {
    const byPriority = b[1].priority - a[1].priority;
    return byPriority !== 0 ? byPriority : a[0].localeCompare(b[0]);
  });
  for (const [name, def] of ranked) {
    if (laneMatches(def.match, brief, labels)) return name;
  }
  throw new LaneLoadError(`no lane matched kind=${brief.kind} tier=${brief.tier}`);
}
