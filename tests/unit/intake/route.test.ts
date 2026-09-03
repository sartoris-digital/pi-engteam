import { describe, expect, it } from "vitest";
import type { Brief, BriefConfidence, TicketKind } from "../../../src/intake/brief-schema.js";
import { formatAbstentionComment, routeBrief } from "../../../src/intake/route.js";

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
    samples: { n: 2, kinds: ["bug", "bug"], acAgreement: 1 },
    prior: { from: "none" },
    confidence: "HIGH",
    tier: "low",
    lane: "bug",
    ...over,
  };
}

const KINDS: TicketKind[] = ["feature", "enhancement", "bug", "chore"];
const LEVELS: BriefConfidence[] = ["HIGH", "MEDIUM", "LOW"];

describe("routeBrief", () => {
  it("routes HIGH/MEDIUM/LOW × four kinds per spec §3.8", () => {
    const rows: Array<{ kind: TicketKind; confidence: BriefConfidence; action: "proceed" | "needs-triage"; elevated?: boolean }> = [];
    for (const kind of KINDS) {
      for (const confidence of LEVELS) {
        const action = confidence === "LOW" ? "needs-triage" : "proceed";
        rows.push({
          kind,
          confidence,
          action,
          elevated: confidence === "MEDIUM" && kind === "feature",
        });
      }
    }
    for (const row of rows) {
      const routed = routeBrief(
        brief({
          kind: row.kind,
          lane: row.kind,
          confidence: row.confidence,
          tier: "low",
          acceptanceCriteria:
            row.kind === "chore"
              ? []
              : [{ id: "AC1", text: "done", source: "quoted", quote: "done" }],
        }),
      );
      expect(routed.action, `${row.kind} ${row.confidence}`).toBe(row.action);
      if (row.action === "proceed") {
        expect(routed.brief.tier).toBe(row.elevated ? "elevated" : "low");
      } else {
        expect(routed.action).toBe("needs-triage");
        expect("comment" in routed && routed.comment.length > 0).toBe(true);
      }
    }
  });

  it("needs-info when every AC is inferred (except chore)", () => {
    for (const kind of ["feature", "enhancement", "bug"] as TicketKind[]) {
      const routed = routeBrief(
        brief({
          kind,
          lane: kind,
          confidence: "HIGH",
          acceptanceCriteria: [{ id: "AC1", text: "guessed", source: "inferred", quote: "" }],
        }),
      );
      expect(routed.action, kind).toBe("needs-info");
      if (routed.action !== "needs-info") throw new Error("expected needs-info");
      expect(routed.comment).toMatch(/acceptance/i);
      expect(routed.comment).toContain(kind);
    }
    const chore = routeBrief(
      brief({
        kind: "chore",
        lane: "chore",
        confidence: "HIGH",
        acceptanceCriteria: [{ id: "AC1", text: "guessed", source: "inferred", quote: "" }],
      }),
    );
    expect(chore.action).toBe("proceed");
  });

  it("raises tier to elevated on injectionSuspect and still proceeds", () => {
    const routed = routeBrief(
      brief({
        kind: "chore",
        lane: "chore",
        confidence: "HIGH",
        flags: ["injectionSuspect"],
        acceptanceCriteria: [],
      }),
    );
    expect(routed.action).toBe("proceed");
    expect(routed.brief.tier).toBe("elevated");
  });
});

describe("formatAbstentionComment", () => {
  it("lists missing items, proposed kind, and quotes proposed AC", () => {
    const comment = formatAbstentionComment({
      brief: brief({ kind: "feature", lane: "feature", confidence: "LOW" }),
      reason: "needs-triage",
      missing: ["classification confidence", "quoted acceptance criteria"],
    });
    expect(comment).toMatch(/could not classify|could not ready/i);
    expect(comment).toContain("feature");
    expect(comment).toContain("classification confidence");
    expect(comment).toMatch(/> .*widgets no longer rattle/);
    expect(comment).toContain("factory:kind=");
    expect(comment).toContain("factory:ready");
  });
});
