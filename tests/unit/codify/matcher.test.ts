import { describe, expect, it } from "vitest";
import {
  MATCH_TIMEOUT_MS,
  matchBounded,
  matchTools,
  type Matchable,
} from "../../../src/codify/matcher.js";
import type { RegistryState } from "../../../src/codify/registry.js";

function tool(over: Partial<Matchable> & Pick<Matchable, "name">): Matchable {
  return {
    version: 1,
    state: "active",
    matcher: {
      titlePatterns: ["chore: bump .+ to .+"],
      planStepPatterns: ["bump .+ version"],
      pathGlobs: ["package.json", "**/package-lock.json"],
    },
    ...over,
  };
}

describe("matchBounded", () => {
  it("is linear-time for ordinary title patterns and defaults to a 5ms budget", () => {
    expect(MATCH_TIMEOUT_MS).toBe(5);
    expect(matchBounded("chore: bump .+ to .+", "chore: bump pkg to 1.3.0", 5)).toEqual({ ok: true });
    expect(matchBounded("chore: bump .+ to .+", "feat: add widget", 5)).toEqual({ ok: false });
  });

  it("times out a known ReDoS (a+)+$ against a long a-string and does not hang", () => {
    const started = Date.now();
    const result = matchBounded("(a+)+$", `${"a".repeat(36)}x`, 5);
    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: false, timedOut: true });
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("matchTools", () => {
  const query = {
    title: "chore: bump pkg to 1.3.0",
    planSteps: ["bump package version", "open PR"],
    likelyPaths: ["package.json"],
  };

  it("matches title and plan-step patterns and reports pathGlob fit", () => {
    const rows: Array<{
      name: string;
      title: string;
      planSteps: string[];
      likelyPaths: string[];
      hit: boolean;
      pathsFit: boolean;
    }> = [
      {
        name: "title-hit",
        title: "chore: bump pkg to 1.3.0",
        planSteps: [],
        likelyPaths: ["package.json"],
        hit: true,
        pathsFit: true,
      },
      {
        name: "plan-hit",
        title: "unrelated title",
        planSteps: ["bump foo version"],
        likelyPaths: ["package.json"],
        hit: true,
        pathsFit: true,
      },
      {
        name: "no-hit",
        title: "docs: fix typo",
        planSteps: ["edit README"],
        likelyPaths: ["package.json"],
        hit: false,
        pathsFit: true,
      },
      {
        name: "paths-miss",
        title: "chore: bump pkg to 1.3.0",
        planSteps: [],
        likelyPaths: ["src/index.ts"],
        hit: true,
        pathsFit: false,
      },
    ];
    for (const row of rows) {
      const result = matchTools([tool({ name: "bump" })], {
        title: row.title,
        planSteps: row.planSteps,
        likelyPaths: row.likelyPaths,
      });
      expect(result.matches.length > 0, row.name).toBe(row.hit);
      if (row.hit) expect(result.matches[0]?.pathsFit, row.name).toBe(row.pathsFit);
    }
  });

  it("forces partial when two entries match", () => {
    const result = matchTools(
      [tool({ name: "bump-a" }), tool({ name: "bump-b", matcher: { titlePatterns: ["chore: bump .+"], planStepPatterns: [], pathGlobs: ["package.json"] } })],
      query,
    );
    expect(result.matches).toHaveLength(2);
    expect(result.forcedPartial).toBe(true);
  });

  it("ignores drifted, demoted, retired, rejected and staged entries", () => {
    const hidden: RegistryState[] = ["drifted", "demoted", "retired", "rejected", "staged"];
    const result = matchTools(
      hidden.map((state) => tool({ name: `x-${state}`, state })),
      query,
    );
    expect(result.matches).toEqual([]);
    expect(matchTools([tool({ name: "ok", state: "probationary" })], query).matches).toHaveLength(1);
    expect(matchTools([tool({ name: "assist", state: "assist" })], query).matches).toHaveLength(1);
  });
});
