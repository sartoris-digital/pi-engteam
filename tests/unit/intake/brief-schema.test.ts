import { describe, expect, it } from "vitest";
import { BriefSchema, BriefSchemaError, parseBrief, type Brief } from "../../../src/intake/brief-schema.js";
import { Value } from "typebox/value";

const valid: Brief = {
  kind: "bug",
  flags: ["security"],
  size: "M",
  reproSteps: "present",
  acceptanceCriteria: [
    { id: "AC1", text: "widgets no longer rattle", source: "quoted", quote: "widgets no longer rattle" },
  ],
  likelyPaths: ["src/widgets.ts"],
  questions: [],
  goal: "bug: stop the rattle [github:acme/widgets#42]",
  samples: { n: 2, kinds: ["bug", "bug"], acAgreement: 1 },
  prior: { kind: "bug", from: "label" },
  confidence: "HIGH",
  tier: "elevated",
  lane: "bug",
};

describe("BriefSchema", () => {
  it("round-trips a valid brief", () => {
    expect(Value.Check(BriefSchema, valid)).toBe(true);
    const parsed = parseBrief(JSON.parse(JSON.stringify(valid)));
    expect(parsed).toEqual(valid);
  });

  it("rejects a missing kind", () => {
    const { kind: _k, ...rest } = valid;
    expect(() => parseBrief(rest)).toThrow(BriefSchemaError);
    expect(() => parseBrief(rest)).toThrow(/kind/i);
  });

  it("rejects an unknown kind", () => {
    expect(() => parseBrief({ ...valid, kind: "epic" })).toThrow(BriefSchemaError);
    expect(() => parseBrief({ ...valid, kind: "epic" })).toThrow(/kind/i);
  });

  it('rejects confidence: "pretty-sure"', () => {
    expect(() => parseBrief({ ...valid, confidence: "pretty-sure" })).toThrow(BriefSchemaError);
    expect(() => parseBrief({ ...valid, confidence: "pretty-sure" })).toThrow(/confidence/i);
  });

  it("rejects the retired {type, summary} contract by name", () => {
    expect(() => parseBrief({ type: "bug", summary: "rattle" })).toThrow(BriefSchemaError);
    expect(() => parseBrief({ type: "bug", summary: "rattle" })).toThrow(/\{type, summary\}/);
  });

  it("rejects the retired {issueType, ac: string[]} contract by name", () => {
    expect(() => parseBrief({ issueType: "bug", ac: ["it works"] })).toThrow(BriefSchemaError);
    expect(() => parseBrief({ issueType: "bug", ac: ["it works"] })).toThrow(/\{issueType, ac: string\[\]\}/);
  });

  it("rejects the retired {classification} contract by name", () => {
    expect(() => parseBrief({ classification: "bug" })).toThrow(BriefSchemaError);
    expect(() => parseBrief({ classification: "bug" })).toThrow(/\{classification\}/);
  });

  it("rejects unknown keys", () => {
    expect(Value.Check(BriefSchema, { ...valid, flavour: "spicy" })).toBe(false);
    expect(() => parseBrief({ ...valid, flavour: "spicy" })).toThrow(BriefSchemaError);
  });
});
