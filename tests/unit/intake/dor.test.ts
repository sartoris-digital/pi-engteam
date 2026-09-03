import { describe, expect, it } from "vitest";
import type { Brief } from "../../../src/intake/brief-schema.js";
import { evaluateDoR } from "../../../src/intake/dor.js";

function brief(over: Partial<Brief> = {}): Brief {
  return {
    kind: "feature",
    flags: [],
    size: "M",
    reproSteps: "absent",
    acceptanceCriteria: [{ id: "AC1", text: "user sees a greeting", source: "quoted", quote: "user sees a greeting" }],
    likelyPaths: ["src/greet.ts"],
    questions: [],
    goal: "add a greeting helper",
    samples: { n: 2, kinds: ["feature", "feature"], acAgreement: 1 },
    prior: { from: "none" },
    confidence: "HIGH",
    tier: "low",
    lane: "feature",
    ...over,
  };
}

const longBody = [
  "## Goal",
  "Add a greeting helper so callers can format a hello message without duplicating string templates across the app.",
  "",
  "## Acceptance",
  "- user sees a greeting when they call greet()",
].join("\n");

const base = {
  repoResolvable: true,
  body: longBody,
  assignedToHuman: false,
  writeRoots: ["src/**", "lib/**"],
};

describe("evaluateDoR", () => {
  it("passes a ready feature with quoted AC, resolvable repo, and in-root paths", () => {
    expect(evaluateDoR(brief(), base)).toEqual({ ok: true });
  });

  it("needs-info when a feature has no quoted or derived AC", () => {
    const result = evaluateDoR(
      brief({
        acceptanceCriteria: [{ id: "AC1", text: "maybe a button", source: "inferred", quote: "" }],
      }),
      base,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.queueState).toBe("needs-info");
    expect(result.failures.some((f) => f.check === "acceptanceCriteria")).toBe(true);
  });

  it("needs-info add writeRoots when likelyPaths sit outside writeRoots", () => {
    const result = evaluateDoR(brief({ likelyPaths: ["docs/secret.md"] }), base);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.queueState).toBe("needs-info");
    expect(result.failures.some((f) => /writeRoots/i.test(f.detail) || f.check === "writeRoots")).toBe(true);
  });

  it("needs-info when a chore has no path or command", () => {
    const result = evaluateDoR(
      brief({
        kind: "chore",
        lane: "chore",
        likelyPaths: [],
        acceptanceCriteria: [],
      }),
      { ...base, body: "## Task\nPlease tidy things up around the repo when you get a chance to look." },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.queueState).toBe("needs-info");
    expect(result.failures.some((f) => f.check === "chore")).toBe(true);
  });

  it("needs-info when the body is under 80 chars after stripping headings", () => {
    const result = evaluateDoR(brief(), {
      ...base,
      body: "## Goal\n## Context\nshort",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.queueState).toBe("needs-info");
    expect(result.failures.some((f) => f.check === "body")).toBe(true);
  });
});
