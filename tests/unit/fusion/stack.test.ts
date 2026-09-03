import { describe, expect, it } from "vitest";
import { FUSION_MODES, validateStack, type FusionSlot } from "../../../src/fusion/index.js";
import { isMode, MODES } from "../../../src/lanes/catalog.js";

function slot(name: string, model: string): FusionSlot {
  return { name, model };
}

describe("FUSION_MODES", () => {
  it("is the spec §4.12 mode list", () => {
    expect([...FUSION_MODES]).toEqual([
      "sample",
      "opinion",
      "fuse",
      "debate",
      "adversarial",
      "veto",
      "collaborate",
    ]);
  });
});

describe("validateStack", () => {
  it("refuses a duplicate model id", () => {
    const result = validateStack([
      slot("A", "zenmux/anthropic/claude-opus-4.6"),
      slot("B", "zenmux/anthropic/claude-opus-4.6"),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/duplicate model/i);
  });

  it("accepts different vendor prefixes", () => {
    const result = validateStack([
      slot("A", "zenmux/anthropic/claude-opus-4.6"),
      slot("B", "openai-codex/gpt-5.6-terra"),
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("warns but accepts two slots that share a vendor prefix", () => {
    const result = validateStack([
      slot("A", "openai-codex/gpt-5.6-terra"),
      slot("B", "openai-codex/gpt-5.6-mini"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toMatch(/openai-codex/);
  });
});

describe("catalog prompt modes", () => {
  it("includes grill, refute, and fuse-synthesize without dropping codified-diff", () => {
    expect(isMode("grill")).toBe(true);
    expect(isMode("refute")).toBe(true);
    expect(isMode("fuse-synthesize")).toBe(true);
    expect(isMode("codified-diff")).toBe(true);
    expect([...MODES]).toContain("codified-diff");
    expect(isMode("assess")).toBe(false);
    expect(isMode("generate")).toBe(false);
  });
});
