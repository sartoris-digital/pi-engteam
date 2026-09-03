import { describe, expect, it } from "vitest";
import { makeScrubber, PROVIDER_TOKEN_PATTERNS } from "../../../src/vault/scrubber.js";

describe("makeScrubber", () => {
  it("replaces exact values and ghp_-shaped tokens", () => {
    const ghp = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const scrub = makeScrubber(["super-secret-value"]);
    expect(scrub(`token=${ghp} and super-secret-value in logs`)).toBe(
      "token=[redacted] and [redacted] in logs",
    );
    expect(PROVIDER_TOKEN_PATTERNS.length).toBeGreaterThan(0);
  });

  it("is fail-closed when patterns cannot be loaded", () => {
    const scrub = makeScrubber(["x"], null);
    expect(scrub("anything including x")).toBe("[redacted]");
  });
});
