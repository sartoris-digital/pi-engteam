import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INPUT_TYPES,
  ORACLES,
  PROVENANCE,
  scoreAssessment,
  type Assessment,
  type Cluster,
  type MemberTree,
} from "../../../src/codify/rubric.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, "../../fixtures/codify/bump-version.assessment.json");

function goldenAssessment(): Assessment {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Assessment;
}

function goldenCluster(): Cluster {
  return {
    signature: "sig-bump-package-version",
    stage: "implement",
    kind: "chore",
    lane: "chore",
    members: [
      {
        runId: "run-a",
        title: "chore: bump fixture-app to 1.1.0",
        literals: ["fixture-app", "1.1.0"],
        observedBranches: { d1: "present" },
      },
      {
        runId: "run-b",
        title: "chore: bump fixture-app to 1.2.0",
        literals: ["fixture-app", "1.2.0"],
        observedBranches: { d1: "present" },
      },
    ],
  };
}

function goldenTrees(): MemberTree[] {
  const pkg = `${JSON.stringify({ name: "fixture-app", version: "1.0.0" }, null, 2)}\n`;
  return [
    { runId: "run-a", files: { "package.json": pkg } },
    { runId: "run-b", files: { "package.json": pkg } },
  ];
}

function rulesOf(failed: { rule: string }[]): string[] {
  return failed.map((f) => f.rule);
}

describe("vocabulary", () => {
  it("freezes the host input / oracle / provenance vocabularies", () => {
    expect([...INPUT_TYPES]).toEqual(["semver", "identifier", "relpath-in-globs", "enum", "shortText"]);
    expect([...ORACLES]).toEqual(["fs", "regex", "exit-code", "input"]);
    expect([...PROVENANCE]).toEqual(["constant", "title:", "brief:", "plan:", "command:", "host:today", "config:"]);
  });
});

describe("scoreAssessment", () => {
  it("scores the golden bump-version assessment as codifiable with no failures", () => {
    const result = scoreAssessment(goldenAssessment(), goldenCluster(), goldenTrees());
    expect(result.verdict).toBe("codifiable");
    expect(result.failed).toEqual([]);
    expect(result.residuals).toEqual([]);
  });

  it("fails R1 when inputs.length > 6", () => {
    const a = goldenAssessment();
    a.inputs = [
      ...a.inputs,
      { name: "a", type: "shortText", provenance: "title:" },
      { name: "b", type: "shortText", provenance: "title:" },
      { name: "c", type: "shortText", provenance: "title:" },
      { name: "d", type: "shortText", provenance: "title:" },
    ];
    const result = scoreAssessment(a, goldenCluster(), goldenTrees());
    expect(rulesOf(result.failed)).toContain("R1");
    expect(result.failed.some((f) => f.rule === "R1" && f.at === "assess")).toBe(true);
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R1 on a free regex input type", () => {
    const a = goldenAssessment();
    a.inputs = [...a.inputs, { name: "pat", type: "regex", provenance: "title:" }];
    const result = scoreAssessment(a, goldenCluster(), goldenTrees());
    expect(rulesOf(result.failed)).toContain("R1");
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R1 when N=1 residuals are non-empty and a constant appears in the title", () => {
    const a = goldenAssessment();
    a.residuals = ["needs a human for the changelog voice"];
    a.inputs = [
      ...a.inputs,
      { name: "token", type: "shortText", provenance: "constant", value: "HOTFIX" },
    ];
    const cluster: Cluster = {
      ...goldenCluster(),
      members: [
        {
          runId: "run-only",
          title: "chore: HOTFIX bump fixture-app to 1.1.0",
          literals: ["fixture-app", "1.1.0", "HOTFIX"],
          observedBranches: { d1: "present" },
        },
      ],
    };
    const result = scoreAssessment(a, cluster, [{ runId: "run-only", files: goldenTrees()[0]!.files }]);
    expect(rulesOf(result.failed)).toContain("R1");
    expect(result.failed.filter((f) => f.rule === "R1" && f.at === "assess").length).toBeGreaterThanOrEqual(1);
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R2 when an oracle does not select the observed branch on a member", () => {
    const oracles = new Map<string, string>([
      ["d1+run-a", "absent"],
      ["d1+run-b", "present"],
    ]);
    const result = scoreAssessment(goldenAssessment(), goldenCluster(), goldenTrees(), { oracles });
    expect(rulesOf(result.failed)).toContain("R2");
    expect(result.failed.some((f) => f.rule === "R2" && f.at === "assess")).toBe(true);
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R2 when an untemplated diff token has no binding", () => {
    const cluster = goldenCluster();
    cluster.members[0]!.diffTokens = ["UNTEMPLATED_SHA"];
    const result = scoreAssessment(goldenAssessment(), cluster, goldenTrees());
    expect(rulesOf(result.failed)).toContain("R2");
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R3 when a postcondition is not a catalog predicate, checks:name, or read-only command", () => {
    const a = goldenAssessment();
    a.postconditions = ["rm -rf /"];
    const result = scoreAssessment(a, goldenCluster(), goldenTrees());
    expect(rulesOf(result.failed)).toContain("R3");
    expect(result.failed.some((f) => f.rule === "R3" && f.at === "assess")).toBe(true);
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R5 when writeGlobs intersect testDir", () => {
    const a = goldenAssessment();
    a.sideEffects.writeGlobs = ["tests/**", "package.json"];
    const result = scoreAssessment(a, goldenCluster(), goldenTrees());
    expect(rulesOf(result.failed)).toContain("R5");
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R5 when writeGlobs intersect securityPaths", () => {
    const a = goldenAssessment();
    a.sideEffects.writeGlobs = ["package.json", "auth/**"];
    const result = scoreAssessment(a, goldenCluster(), goldenTrees());
    expect(rulesOf(result.failed)).toContain("R5");
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R5 when allowedCommands contains git commit", () => {
    const a = goldenAssessment();
    a.allowedCommands = ["git commit"];
    const result = scoreAssessment(a, goldenCluster(), goldenTrees());
    expect(rulesOf(result.failed)).toContain("R5");
    expect(result.verdict).toBe("not-codifiable");
  });

  it("fails R6 when bindings miss a member literal", () => {
    const cluster = goldenCluster();
    cluster.members[0]!.literals = ["fixture-app", "1.1.0", "MISSING_LITERAL"];
    const result = scoreAssessment(goldenAssessment(), cluster, goldenTrees());
    expect(rulesOf(result.failed)).toContain("R6");
    expect(result.failed.some((f) => f.rule === "R6" && f.at === "assess")).toBe(true);
    expect(result.verdict).toBe("not-codifiable");
  });

  it("records R4 and R7 as validate-time and does not fail assess on them", () => {
    const result = scoreAssessment(goldenAssessment(), goldenCluster(), goldenTrees());
    expect(result.failed.filter((f) => f.at === "validate")).toEqual([]);
    expect(result.verdict).toBe("codifiable");
  });
});
