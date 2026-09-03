import { describe, expect, it } from "vitest";
import { mergeAdversarial } from "../../../src/fusion/adversarial.js";
import {
  debatePacket,
  debateRoundsArtifact,
  mergeDebate,
  mergeDebateRounds,
  positionsChanged,
} from "../../../src/fusion/debate.js";
import { mergeFuse } from "../../../src/fusion/fuse.js";
import { mergeOpinion } from "../../../src/fusion/opinion.js";
import { mergeSample } from "../../../src/fusion/sample.js";
import type { SlotResult } from "../../../src/fusion/types.js";
import { mergeVeto } from "../../../src/fusion/veto.js";

function slot(over: Partial<SlotResult> & Pick<SlotResult, "name">): SlotResult {
  return { model: `model-${over.name}`, text: "", ...over };
}

describe("mergeSample", () => {
  it.each([
    {
      name: "majority PASS with unioned flags",
      slots: [
        slot({ name: "A", verdict: "PASS", flags: ["security"] }),
        slot({ name: "B", verdict: "PASS", flags: ["perf"] }),
        slot({ name: "C", verdict: "FAIL", flags: ["security"], issues: ["nope"] }),
      ],
      verdict: "PASS" as const,
      flags: ["security", "perf"],
    },
    {
      name: "majority FAIL",
      slots: [
        slot({ name: "A", verdict: "FAIL", issues: ["a"] }),
        slot({ name: "B", verdict: "FAIL", issues: ["b"] }),
        slot({ name: "C", verdict: "PASS" }),
      ],
      verdict: "FAIL" as const,
      flags: [],
    },
    {
      name: "tie becomes NEEDS_MORE",
      slots: [slot({ name: "A", verdict: "PASS" }), slot({ name: "B", verdict: "FAIL" })],
      verdict: "NEEDS_MORE" as const,
      flags: [],
    },
  ])("$name", ({ slots, verdict, flags }) => {
    const result = mergeSample(slots);
    expect(result.verdict).toBe(verdict);
    if (flags.length > 0) {
      expect(result.issues?.join(" ")).toMatch(/security/);
      expect(result.issues?.join(" ")).toMatch(/perf/);
    }
  });
});

describe("mergeOpinion", () => {
  it("concatenates labelled slot texts and does not pick a winner", () => {
    const result = mergeOpinion([
      slot({ name: "A", text: "plan alpha", verdict: "PASS" }),
      slot({ name: "B", text: "plan beta", verdict: "FAIL" }),
    ]);
    expect(result.verdict).toBe("PASS");
    expect(result.issues ?? []).toEqual([]);
    const artifact = result.artifacts?.opinion ?? "";
    expect(artifact).toContain("[A]");
    expect(artifact).toContain("plan alpha");
    expect(artifact).toContain("[B]");
    expect(artifact).toContain("plan beta");
  });
});

describe("mergeFuse", () => {
  const synth = (text: string): SlotResult[] => [
    slot({ name: "A", text: "proposal A" }),
    slot({ name: "B", text: "proposal B" }),
    slot({ name: "synthesizer", text }),
  ];

  it.each([
    {
      name: "PASS when required sections cite slots and have no CONFLICT",
      text: "## Goal\nShip the widget [A]\n## Approach\nReuse the helper [B]\n",
      verdict: "PASS" as const,
    },
    {
      name: "FAIL when a section cites no slot",
      text: "## Goal\nShip the widget [A]\n## Approach\nDo something clever\n",
      verdict: "FAIL" as const,
    },
    {
      name: "FAIL on unresolved [CONFLICT]",
      text: "## Goal\nShip the widget [A]\n## Approach\n[CONFLICT] two paths [B]\n",
      verdict: "FAIL" as const,
    },
    {
      name: "FAIL when a required section is missing",
      text: "## Goal\nShip the widget [A]\n",
      verdict: "FAIL" as const,
    },
  ])("$name", ({ text, verdict }) => {
    expect(mergeFuse(synth(text)).verdict).toBe(verdict);
  });
});

describe("mergeAdversarial", () => {
  it("treats confirmed-by-both as blocking, keeps cited A-only, appends B missed", () => {
    const result = mergeAdversarial([
      slot({
        name: "A",
        text: JSON.stringify({
          findings: [
            { id: "t1", citation: "tests/a.test.ts:1" },
            { id: "t2" },
            { id: "t3", citation: "src/a.ts:4" },
          ],
        }),
      }),
      slot({
        name: "B",
        text: JSON.stringify({
          confirmed: [{ id: "t1" }],
          refuted: [],
          missed: [{ id: "m1", citation: "src/b.ts:2" }],
        }),
      }),
    ]);
    expect(result.verdict).toBe("FAIL");
    const issues = result.issues ?? [];
    expect(issues.some((i) => i.includes("t1"))).toBe(true);
    expect(issues.some((i) => i.includes("t3"))).toBe(true);
    expect(issues.some((i) => i.includes("m1"))).toBe(true);
    expect(issues.some((i) => i.includes("t2"))).toBe(false);
  });

  it("PASSes when nothing is confirmed-by-both", () => {
    const result = mergeAdversarial([
      slot({ name: "A", text: JSON.stringify({ findings: [{ id: "x", citation: "a.ts:1" }] }) }),
      slot({ name: "B", text: JSON.stringify({ confirmed: [], refuted: [], missed: [] }) }),
    ]);
    expect(result.verdict).toBe("PASS");
    expect(result.issues?.some((i) => i.includes("x"))).toBe(true);
  });
});

describe("mergeVeto", () => {
  it.each([
    {
      name: "all PASS",
      slots: [slot({ name: "A", verdict: "PASS" }), slot({ name: "B", verdict: "PASS" })],
      verdict: "PASS" as const,
    },
    {
      name: "any FAIL wins over NEEDS_MORE",
      slots: [
        slot({ name: "A", verdict: "FAIL", issues: ["bad"] }),
        slot({ name: "B", verdict: "NEEDS_MORE", issues: ["more"] }),
      ],
      verdict: "FAIL" as const,
    },
    {
      name: "NEEDS_MORE if no FAIL",
      slots: [slot({ name: "A", verdict: "PASS" }), slot({ name: "B", verdict: "NEEDS_MORE" })],
      verdict: "NEEDS_MORE" as const,
    },
    {
      name: "missing slot fails closed",
      slots: [slot({ name: "A", verdict: "PASS" }), slot({ name: "B", text: "gone" })],
      verdict: "FAIL" as const,
    },
    {
      name: "timed-out slot fails closed",
      slots: [slot({ name: "A", verdict: "PASS" }), slot({ name: "B", verdict: "PASS", timedOut: true })],
      verdict: "FAIL" as const,
    },
    {
      name: "empty slot list fails closed",
      slots: [] as SlotResult[],
      verdict: "FAIL" as const,
    },
  ])("$name", ({ slots, verdict }) => {
    const result = mergeVeto(slots);
    expect(result.verdict).toBe(verdict);
    if (verdict === "FAIL" && slots.some((s) => s.issues?.includes("bad"))) {
      expect(result.issues?.join(" ")).toMatch(/\[A\].*bad/);
    }
  });
});

describe("mergeDebate", () => {
  it("extracts sentence-level agreement without judging", () => {
    const result = mergeDebate([
      slot({ name: "A", text: "The bug is in parse(). Auth is fine." }),
      slot({ name: "B", text: "The bug is in parse(). Auth is broken." }),
    ]);
    expect(result.verdict).toBe("PASS");
    const artifact = result.artifacts?.debate ?? "";
    expect(artifact).toMatch(/Agreement/i);
    expect(artifact).toContain("The bug is in parse().");
    expect(artifact).toMatch(/Disagreement/i);
    expect(artifact).toContain("Auth is fine.");
    expect(artifact).toContain("Auth is broken.");
  });

  it("attributes each disagreement to the slots holding it", () => {
    const artifact =
      mergeDebate([
        slot({ name: "A", text: "Auth is fine." }),
        slot({ name: "B", text: "Auth is broken." }),
        slot({ name: "C", text: "Auth is broken." }),
      ]).artifacts?.debate ?? "";
    expect(artifact).toContain("[B][C] Auth is broken.");
    expect(artifact).toContain("[A] Auth is fine.");
  });
});

describe("debatePacket", () => {
  const prior = [
    slot({ name: "A", text: "keep the cache", verdict: "PASS", fenced: "<<<FENCED-A>>>" }),
    slot({ name: "B", text: "drop the cache", verdict: "PASS" }),
    slot({ name: "C", text: "", error: "provider down" }),
  ];

  it("labels every other slot and fences its opinion, excluding the reader's own", () => {
    const packet = debatePacket("A", prior, "nonce-x");
    expect(packet).not.toContain("[A]");
    expect(packet).toContain("## [B] model-B — CONCRETE OPINION");
    expect(packet).toContain("<<<UNTRUSTED_FUSION-B_nonce-x_BEGIN>>>");
    expect(packet).toContain("drop the cache");
  });

  it("labels a failed participant instead of leaking its error text", () => {
    const packet = debatePacket("B", prior, "nonce-x");
    expect(packet).toContain("## [C] model-C — PARTICIPANT UNAVAILABLE");
    expect(packet).not.toContain("provider down");
    expect(packet).toContain("<<<FENCED-A>>>");
  });
});

describe("positionsChanged", () => {
  it("ignores whitespace and case, and reports a genuinely new position", () => {
    const before = [slot({ name: "A", text: "The bug is in parse()." })];
    expect(positionsChanged(before, [slot({ name: "A", text: "  the BUG   is in parse().  " })])).toBe(false);
    expect(positionsChanged(before, [slot({ name: "A", text: "The bug is in lex()." })])).toBe(true);
    expect(positionsChanged(before, [slot({ name: "Z", text: "new voice" })])).toBe(true);
  });
});

describe("mergeDebateRounds", () => {
  it("merges the final round and keeps the round-by-round progression", () => {
    const result = mergeDebateRounds([
      [slot({ name: "A", text: "Auth is fine.", verdict: "PASS" }), slot({ name: "B", text: "Auth is broken.", verdict: "PASS" })],
      [slot({ name: "A", text: "Auth is broken.", verdict: "PASS" }), slot({ name: "B", text: "Auth is broken.", verdict: "PASS" })],
    ]);
    expect(result.verdict).toBe("PASS");
    const artifact = result.artifacts?.debate ?? "";
    expect(artifact).toContain("## Agreement");
    expect(artifact).toContain("- Auth is broken.");
    expect(artifact).not.toContain("Auth is fine.");
    const progression = result.artifacts?.debateRounds ?? "";
    expect(progression).toContain("## Round 1");
    expect(progression).toContain("Auth is fine.");
    expect(progression).toContain("## Round 2");
  });

  it("drops the final round's failed slots from the merge but keeps them in the transcript", () => {
    const rounds = [
      [slot({ name: "A", text: "keep it", verdict: "PASS" }), slot({ name: "B", text: "", error: "boom" })],
    ];
    expect(debateRoundsArtifact(rounds)).toContain("### [B] model-B — UNAVAILABLE");
    expect(mergeDebateRounds(rounds).artifacts?.debate ?? "").toContain("keep it");
  });
});
