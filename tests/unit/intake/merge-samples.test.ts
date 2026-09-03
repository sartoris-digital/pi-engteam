import { describe, expect, it } from "vitest";
import type { Brief } from "../../../src/intake/brief-schema.js";
import { mergeSamples } from "../../../src/intake/merge-samples.js";

function brief(over: Partial<Brief> = {}): Brief {
  return {
    kind: "bug",
    flags: [],
    size: "M",
    reproSteps: "present",
    acceptanceCriteria: [{ id: "AC1", text: "widgets no longer rattle", source: "quoted", quote: "widgets no longer rattle" }],
    likelyPaths: ["src/widgets.ts"],
    questions: [],
    goal: "stop the rattle",
    samples: { n: 1, kinds: ["bug"], acAgreement: 1 },
    prior: { from: "none" },
    confidence: "LOW",
    tier: "low",
    lane: "bug",
    ...over,
  };
}

describe("mergeSamples", () => {
  it("takes majority kind, unions flags and likelyPaths, intersects possibleDuplicateOf", () => {
    const a = brief({
      kind: "bug",
      flags: ["security"],
      likelyPaths: ["src/a.ts"],
      possibleDuplicateOf: "github:acme/widgets#1",
    });
    const b = brief({
      kind: "bug",
      flags: ["perf"],
      likelyPaths: ["src/b.ts"],
      possibleDuplicateOf: "github:acme/widgets#1",
    });
    const c = brief({
      kind: "chore",
      flags: ["security"],
      likelyPaths: ["src/a.ts"],
      possibleDuplicateOf: "github:acme/widgets#9",
    });
    const merged = mergeSamples([a, b, c]);
    expect(merged.kind).toBe("bug");
    expect(merged.flags.sort()).toEqual(["perf", "security"]);
    expect(merged.likelyPaths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(merged.possibleDuplicateOf).toBeUndefined();
    expect(merged.samples.n).toBe(3);
    expect(merged.samples.kinds).toEqual(["bug", "bug", "chore"]);
  });

  it("keeps possibleDuplicateOf when every sample names the same ref", () => {
    const dup = "github:acme/widgets#1";
    const merged = mergeSamples([
      brief({ possibleDuplicateOf: dup }),
      brief({ possibleDuplicateOf: dup }),
    ]);
    expect(merged.possibleDuplicateOf).toBe(dup);
  });

  it("takes acceptanceCriteria from the sample with more quoted ACs", () => {
    const fewQuoted = brief({
      acceptanceCriteria: [
        { id: "AC1", text: "a", source: "quoted", quote: "a" },
        { id: "AC2", text: "b", source: "inferred", quote: "" },
      ],
    });
    const moreQuoted = brief({
      acceptanceCriteria: [
        { id: "AC1", text: "quoted one", source: "quoted", quote: "quoted one" },
        { id: "AC2", text: "quoted two", source: "quoted", quote: "quoted two" },
      ],
    });
    const merged = mergeSamples([fewQuoted, moreQuoted]);
    expect(merged.acceptanceCriteria.map((ac) => ac.text)).toEqual(["quoted one", "quoted two"]);
  });

  it("records Jaccard acAgreement over normalised AC token sets", () => {
    const a = brief({
      acceptanceCriteria: [
        { id: "AC1", text: "User can log in", source: "quoted", quote: "User can log in" },
        { id: "AC2", text: "Session expires", source: "derived", quote: "session" },
      ],
    });
    const b = brief({
      acceptanceCriteria: [
        { id: "AC1", text: "user can log in", source: "quoted", quote: "user can log in" },
        { id: "AC2", text: "shows error", source: "inferred", quote: "" },
      ],
    });
    const merged = mergeSamples([a, b]);
    // tokens A: user,can,log,in,session,expires  B: user,can,log,in,shows,error → 4/8 = 0.5
    expect(merged.samples.acAgreement).toBeCloseTo(0.5, 5);
  });
});
