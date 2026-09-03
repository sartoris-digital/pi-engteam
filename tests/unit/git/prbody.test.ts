import { describe, it, expect } from "vitest";
import { composePrBody, neutralizeQuoted } from "../../../src/git/prbody.js";

const run = { runId: "run-0001", wallSeconds: 12, iteration: 1, costUsd: 0.4 };

describe("neutralizeQuoted", () => {
  it("wraps a leading /approve so it cannot trigger a bot", () => {
    expect(neutralizeQuoted("/approve")).toBe("`/approve`");
    expect(neutralizeQuoted("/approve\nplease")).toBe("`/approve`\nplease");
  });

  it("wraps leading @ and ! tokens and the deny-list phrases", () => {
    const out = neutralizeQuoted("@dependabot merge\natlantis\n/deploy now\nterraform apply\n/lgtm\n/merge");
    expect(out).toContain("`@dependabot`");
    expect(out).toContain("`atlantis`");
    expect(out).toContain("`/deploy`");
    expect(out).toContain("`terraform`");
    expect(out).toContain("`/lgtm`");
    expect(out).toContain("`/merge`");
  });

  it("caps quoted text at 8 KB", () => {
    const huge = "a".repeat(20_000);
    const out = neutralizeQuoted(huge);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8192);
  });
});

describe("composePrBody", () => {
  it("keeps host headings and quotes the judge summary so injected headings cannot escape", () => {
    const body = composePrBody({
      judgeSummary: "looks good\n## injected\n/approve",
      run,
      ticketLine: "Fixes #42",
    });
    expect(body).toContain("## Acceptance criteria");
    expect(body).toMatch(/^## /m);
    const judgeBlock = body.slice(body.indexOf("## Judge"), body.indexOf("## Classification"));
    expect(judgeBlock).toContain("> looks good");
    expect(judgeBlock).toContain("> ## injected");
    expect(judgeBlock).toContain("> `/approve`");
    expect(judgeBlock).not.toMatch(/^(?!>)## injected/m);
    const unquotedHeadings = body
      .split("\n")
      .filter((line) => line.startsWith("## ") && !line.startsWith(">"));
    expect(unquotedHeadings).not.toContain("## injected");
  });

  it("still emits ## Acceptance criteria when judgeSummary is empty", () => {
    const body = composePrBody({ run, ticketLine: "Source: local task local-1" });
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("Source: local task local-1");
    expect(body).not.toContain("## injected");
  });

  it("renders AC checklist from the brief with quoted vs inferred markers", () => {
    const body = composePrBody({
      brief: {
        kind: "bug",
        confidence: "HIGH",
        tier: "low",
        lane: "bug",
        acceptanceCriteria: [
          { id: "AC1", text: "returns 404", source: "quoted", quote: "must 404" },
          { id: "AC2", text: "logs the miss", source: "inferred" },
        ],
      },
      gate: { redIds: ["t-missing"], greenIds: ["t-missing"] },
      run,
      ticketLine: "Fixes #7",
      coAuthoredBy: "Pat Doe <pat@example.com>",
      rulesApplied: ["r-builtin-no-generated-docs"],
    });
    expect(body).toMatch(/## Classification/);
    expect(body).toMatch(/kind:\s*bug/);
    expect(body).toContain("AC1");
    expect(body).toContain("quoted");
    expect(body).toContain("inferred");
    expect(body).toContain("Fixes #7");
    expect(body).toContain("Co-Authored-By: Pat Doe <pat@example.com>");
    expect(body).toContain("r-builtin-no-generated-docs");
    expect(body).toContain("t-missing");
  });
});
