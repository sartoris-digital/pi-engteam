import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSteerPacket,
  extractAcLines,
  extractSection,
  listItems,
  planSummary,
  steerPacketPaths,
} from "../../../src/steer/packet.js";
import { makeRepoConfig, makeRunState } from "../../helpers/steer-fixtures.js";

const MARKER = "<!-- pi-sdlc-factory generated · run run-0001 · do not commit -->";
const HEADINGS = [
  "## Classification",
  "## Acceptance criteria",
  "## Plan",
  "## RED tests",
  "## Files to touch",
  "## Budget",
  "## Open questions",
];
const PLAN = [
  MARKER,
  "",
  "# Plan",
  "",
  "## Goal",
  "Rename the README heading to match the package name.",
  "",
  "## Files to touch",
  "- `README.md`",
  "- docs/intro.md",
  "",
  "## Steps",
  "1. Edit the heading",
  "",
  "## Verify",
  "- pnpm test",
  "",
  "## Out of scope",
  "- package.json",
  "",
  "## Open questions",
  "- Keep the old badge row?",
  "",
].join("\n");

function gateEvidence(round: number, paths: string[]): string {
  return JSON.stringify({
    stage: "gate",
    round,
    agent: "tester",
    verdict: "PASS",
    predicates: [{ name: "red-baseline", ok: true, note: `${paths.length} failing, 0 passing` }],
    artifacts: paths.map((path) => ({ path, sha256: "0".repeat(64) })),
    commands: [],
    synthesized: [],
    timedOut: false,
    headSha: "a".repeat(40),
    at: "2026-09-02T09:04:00.000Z",
  });
}

let tmp: string;
let runDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sdlc-packet-"));
  runDir = join(tmp, "runs", "run-0001");
  await mkdir(runDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("composeSteerPacket", () => {
  it("renders every section from plan.md, ticket.md and gate evidence and writes md + json", async () => {
    await writeFile(join(runDir, "plan.md"), PLAN);
    await writeFile(
      join(runDir, "ticket.md"),
      [MARKER, "", "Rename README heading", "", "AC1: The H1 reads `@sartoris/pi-sdlc-factory`.", "- [ ] badges still render", ""].join("\n"),
    );
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(join(runDir, "evidence", "stage-gate-r1.json"), gateEvidence(1, ["tests/readme.test.ts"]));
    await writeFile(
      join(runDir, "evidence", "stage-gate-r2.json"),
      gateEvidence(2, ["tests/readme.test.ts", "tests/badges.test.ts"]),
    );

    const packet = await composeSteerPacket(
      makeRunState({ runId: "run-0001", tier: "elevated" }),
      runDir,
      makeRepoConfig({ steering: "elevated" }),
      { now: () => new Date("2026-09-02T10:00:00Z") },
    );

    expect(steerPacketPaths(runDir)).toEqual({
      markdownPath: join(runDir, "steer-packet.md"),
      jsonPath: join(runDir, "steer-packet.json"),
    });
    expect(packet.markdownPath).toBe(join(runDir, "steer-packet.md"));
    expect(packet.jsonPath).toBe(join(runDir, "steer-packet.json"));
    expect(packet.markdown.split("\n")[0]).toBe(MARKER);
    for (const heading of HEADINGS) expect(packet.markdown).toContain(heading);
    expect(packet.markdown).toContain("# Steer packet · local-01ARZ3NDEKTSV4RRFFQ69G5FAV · run run-0001");
    expect(packet.markdown).toContain("`/factory approve local-01ARZ3NDEKTSV4RRFFQ69G5FAV`");
    expect(packet.markdown).toContain("- kind: chore");
    expect(packet.markdown).toContain("- tier: elevated");
    expect(packet.markdown).toContain("- lane: chore");
    expect(packet.markdown).toContain("- AC1 (quoted): The H1 reads `@sartoris/pi-sdlc-factory`.");
    expect(packet.markdown).toContain("- AC2 (derived): badges still render");
    expect(packet.markdown).toContain("Rename the README heading to match the package name.");
    expect(packet.markdown).toContain("From gate evidence round 2 — 2 failing, 0 passing:");
    expect(packet.markdown).toContain("- tests/badges.test.ts");
    expect(packet.markdown).toContain("- max wall: 1800 s (used 12 s)");
    expect(packet.markdown).toContain("- max cost: $5.00 (used $0.12)");
    expect(packet.markdown).toContain("- steering policy: elevated");
    expect(packet.markdown).toContain("- Keep the old badge row?");

    expect(packet.json.generated).toBe(MARKER);
    expect(packet.json.runId).toBe("run-0001");
    expect(packet.json.composedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(packet.json.classification).toEqual({ kind: "chore", tier: "elevated", lane: "chore", confidence: null });
    expect(packet.json.acceptanceCriteria).toEqual([
      { id: "AC1", text: "The H1 reads `@sartoris/pi-sdlc-factory`.", source: "quoted" },
      { id: "AC2", text: "badges still render", source: "derived" },
    ]);
    expect(packet.json.plan).toEqual({
      present: true,
      path: join(runDir, "plan.md"),
      summary: "Rename the README heading to match the package name.",
    });
    expect(packet.json.filesToTouch).toEqual(["README.md", "docs/intro.md"]);
    expect(packet.json.redTests).toEqual(["tests/readme.test.ts", "tests/badges.test.ts"]);
    expect(packet.json.openQuestions).toEqual(["Keep the old badge row?"]);
    expect(packet.json.budget).toEqual({
      fixRounds: 2,
      maxWallSeconds: 1800,
      maxCostUsd: 5,
      maxIterations: 9,
      wallSecondsUsed: 12,
      costUsd: 0.12,
      steering: "elevated",
    });

    expect(await readFile(packet.markdownPath, "utf8")).toBe(packet.markdown);
    expect(JSON.parse(await readFile(packet.jsonPath, "utf8"))).toEqual(packet.json);
  });

  it("degrades honestly when there is no plan, brief, ticket text or gate evidence", async () => {
    const packet = await composeSteerPacket(makeRunState({ runId: "run-0001" }), runDir, makeRepoConfig());
    expect(packet.json.plan).toEqual({ present: false, path: null, summary: "" });
    expect(packet.json.acceptanceCriteria).toEqual([]);
    expect(packet.json.filesToTouch).toEqual([]);
    expect(packet.json.redTests).toEqual([]);
    expect(packet.json.openQuestions).toEqual([]);
    expect(packet.markdown).toContain("- confidence: n/a (no intake brief)");
    expect(packet.markdown).toContain("none stated — the implementer works from the task text");
    expect(packet.markdown).toContain("no plan.md in the run dir (lane has no plan stage)");
    expect(packet.markdown).toContain("none (no gate evidence recorded — lane has no gate stage)");
    expect(packet.markdown).toContain("not declared");
    expect(packet.markdown).toContain("## Open questions\nnone");
  });

  it("prefers brief.json over ticket.md for ACs, confidence, likelyPaths and questions", async () => {
    await writeFile(
      join(runDir, "brief.json"),
      JSON.stringify({
        kind: "chore",
        confidence: "HIGH",
        acceptanceCriteria: [
          { id: "AC1", text: "Heading matches the package name", source: "quoted", quote: "match the package name" },
          { id: "AC2", text: "Badges unchanged", source: "derived" },
          { id: "AC3", text: "Something odd", source: "guessed" },
          { id: 4, text: "malformed" },
        ],
        likelyPaths: ["README.md"],
        questions: ["Which badge set is canonical?", 42],
      }),
    );
    await writeFile(join(runDir, "ticket.md"), "AC9: ignored because brief.json wins\n");

    const packet = await composeSteerPacket(makeRunState({ runId: "run-0001" }), runDir, makeRepoConfig());
    expect(packet.json.classification.confidence).toBe("HIGH");
    expect(packet.json.acceptanceCriteria).toEqual([
      { id: "AC1", text: "Heading matches the package name", source: "quoted" },
      { id: "AC2", text: "Badges unchanged", source: "derived" },
      { id: "AC3", text: "Something odd", source: "inferred" },
    ]);
    expect(packet.json.filesToTouch).toEqual(["README.md"]);
    expect(packet.json.openQuestions).toEqual(["Which badge set is canonical?"]);
    expect(packet.markdown).not.toContain("AC9");
  });

  it("falls back to task.md when ticket.md is absent", async () => {
    await writeFile(join(runDir, "task.md"), "Do the thing\nAC1: it is done\n");
    const packet = await composeSteerPacket(makeRunState({ runId: "run-0001" }), runDir, makeRepoConfig());
    expect(packet.json.acceptanceCriteria).toEqual([{ id: "AC1", text: "it is done", source: "quoted" }]);
  });

  it("includes an exact-hit dry-run patch on the packet", async () => {
    const patch = "diff --git a/package.json b/package.json\n";
    const packet = await composeSteerPacket(makeRunState({ runId: "run-0001" }), runDir, makeRepoConfig(), {
      now: () => new Date("2026-09-02T10:00:00Z"),
      codifiedDryRun: { name: "bump-package-version", version: 1, class: "stage-tool", patch },
    });
    expect(packet.json.codifiedDryRun).toEqual({
      name: "bump-package-version",
      version: 1,
      class: "stage-tool",
      patch,
    });
    expect(packet.markdown).toContain("## Codified dry-run");
    expect(packet.markdown).toContain("bump-package-version@1");
    expect(packet.markdown).toContain(patch.trim());
  });
});

describe("section helpers", () => {
  it("extractSection returns the body up to the next heading, case-insensitively", () => {
    expect(extractSection(PLAN, "files to touch")).toBe("- `README.md`\n- docs/intro.md");
    expect(extractSection(PLAN, "Goal")).toBe("Rename the README heading to match the package name.");
    expect(extractSection(PLAN, "Missing")).toBeNull();
  });

  it("listItems strips bullets, numbering and wrapping backticks", () => {
    expect(listItems("- `README.md`\n* docs/intro.md\n2. src/x.ts\nnot an item")).toEqual([
      "README.md",
      "docs/intro.md",
      "src/x.ts",
    ]);
    expect(listItems(null)).toEqual([]);
  });

  it("extractAcLines numbers checklist items after the highest explicit AC id", () => {
    expect(extractAcLines("AC3: x\n- [x] y\n- [ ] z\nplain")).toEqual([
      { id: "AC3", text: "x", source: "quoted" },
      { id: "AC4", text: "y", source: "derived" },
      { id: "AC5", text: "z", source: "derived" },
    ]);
  });

  it("planSummary prefers the Goal section and otherwise the first 30 non-marker lines", () => {
    expect(planSummary(PLAN)).toBe("Rename the README heading to match the package name.");
    const noGoal = [MARKER, "line 1", "line 2"].join("\n");
    expect(planSummary(noGoal)).toBe("line 1\nline 2");
  });
});
