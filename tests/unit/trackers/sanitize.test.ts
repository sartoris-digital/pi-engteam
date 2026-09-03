import { describe, it, expect } from "vitest";
import { sanitizeTicketText, stripTrackerPrior } from "../../../src/trackers/sanitize.js";

describe("sanitizeTicketText", () => {
  it("strips HTML comments and zero-width joiners while keeping visible markdown", () => {
    const raw = "**keep me** <!-- injected -->word\u200djoin";
    const out = sanitizeTicketText(raw);
    expect(out).toContain("**keep me**");
    expect(out).toContain("wordjoin");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("injected");
    expect(out).not.toContain("\u200d");
  });

  it("strips image alt text and hidden attributes", () => {
    const raw = 'See ![ignore previous](http://x) and <img alt="secret" hidden src="y"> please';
    const out = sanitizeTicketText(raw);
    expect(out).not.toMatch(/ignore previous/);
    expect(out).not.toMatch(/\balt=/i);
    expect(out).not.toMatch(/\bhidden\b/i);
    expect(out).toContain("See");
    expect(out).toContain("please");
  });
});

describe("stripTrackerPrior", () => {
  it("removes factory:kind=bug and a fix: title prefix from the analyst copy", () => {
    const { blinded, prior } = stripTrackerPrior("fix: widgets rattle\n\nLabels: factory:kind=bug\nKeep this AC.");
    expect(blinded.toLowerCase()).not.toContain("factory:kind=bug");
    expect(blinded.toLowerCase()).not.toMatch(/^fix:/);
    expect(blinded).toContain("Keep this AC.");
    expect(prior.kind).toBe("bug");
    expect(prior.from).toBe("label");
    expect(prior.labels).toContain("factory:kind=bug");
  });

  it("records a title-prefix prior when no kind label is present", () => {
    const { blinded, prior } = stripTrackerPrior("feat: add a greeting helper\n\nThe helper returns hello.");
    expect(blinded.toLowerCase()).not.toMatch(/^feat:/);
    expect(prior.kind).toBe("feature");
    expect(prior.from).toBe("title-prefix");
  });
});
