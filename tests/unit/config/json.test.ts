import { describe, it, expect } from "vitest";
import { canonicalJson, isPlainObject } from "../../../src/config/json.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("is stable under key reordering and drops undefined members", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: [undefined] })).toBe(canonicalJson({ c: [null], a: 1 }));
  });

  it("encodes scalars like JSON.stringify", () => {
    expect(canonicalJson("s")).toBe('"s"');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("isPlainObject", () => {
  it("accepts object literals only", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});
