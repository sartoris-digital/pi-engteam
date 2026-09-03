import { describe, expect, it } from "vitest";
import { WhenError, tokenize } from "../../../src/lanes/expr.js";

const kinds = (src: string): string[] => tokenize(src).filter((t) => t.kind !== "eof").map((t) => t.kind);
const values = (src: string): string[] => tokenize(src).filter((t) => t.kind !== "eof").map((t) => t.value);

describe("tokenize", () => {
  it("lexes identifiers, dotted paths and numbers", () => {
    expect(kinds("brief.reproSteps")).toEqual(["ident", "dot", "ident"]);
    expect(values("brief.reproSteps")).toEqual(["brief", ".", "reproSteps"]);
    expect(kinds("iteration")).toEqual(["ident"]);
    expect(values("3")).toEqual(["3"]);
    expect(tokenize("3")[0]).toMatchObject({ kind: "number", value: "3" });
  });

  it("lexes single- and double-quoted strings", () => {
    expect(tokenize("'absent'")[0]).toEqual(expect.objectContaining({ kind: "string", value: "absent" }));
    expect(tokenize('"elevated"')[0]).toEqual(expect.objectContaining({ kind: "string", value: "elevated" }));
    expect(tokenize("'it\\'s'")[0]).toEqual(expect.objectContaining({ kind: "string", value: "it's" }));
  });

  it("lexes == != && || ! in and parentheses", () => {
    expect(kinds("a == b != c && d || e")).toEqual([
      "ident", "eq", "ident", "neq", "ident", "and", "ident", "or", "ident",
    ]);
    expect(kinds("!x")).toEqual(["not", "ident"]);
    expect(kinds("'hotfix' in labels")).toEqual(["string", "in", "ident"]);
    expect(kinds("(a)")).toEqual(["lparen", "ident", "rparen"]);
  });

  it("lexes boolean literals as keywords, not idents", () => {
    expect(kinds("true || false")).toEqual(["true", "or", "false"]);
  });

  it("lexes diff.touches(securityPaths) as ident/dot/ident/lparen/ident/rparen", () => {
    expect(kinds("diff.touches(securityPaths)")).toEqual([
      "ident", "dot", "ident", "lparen", "ident", "rparen",
    ]);
    expect(values("diff.touches(securityPaths)")).toEqual([
      "diff", ".", "touches", "(", "securityPaths", ")",
    ]);
  });

  it("throws WhenError on an unexpected character or unterminated string", () => {
    expect(() => tokenize("a >= 5")).toThrow(WhenError);
    expect(() => tokenize("a > b")).toThrow(WhenError);
    expect(() => tokenize("'oops")).toThrow(WhenError);
    expect(() => tokenize("tier = 'low'")).toThrow(/==/);
  });
});
