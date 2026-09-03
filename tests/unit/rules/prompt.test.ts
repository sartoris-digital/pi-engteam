import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStepPrompt } from "../../../src/runtime/prompt.js";
import { operatorRulesBlock } from "../../../src/rules/prompt.js";
import type { RuleRecord } from "../../../src/rules/schema.js";

function rule(over: Partial<RuleRecord> & Pick<RuleRecord, "id" | "text" | "class">): RuleRecord {
  return {
    scope: { repo: "*", lane: "*", stage: ["implement", "review"], kind: "*", paths: [] },
    enforce: ["prompt"],
    createdAt: "2026-09-02T00:00:00.000Z",
    author: "operator",
    status: "active",
    ...over,
  };
}

describe("operatorRulesBlock", () => {
  it("gives implement constraint+guidance scoped to implement, and review only constraints", () => {
    const rules = [
      rule({
        id: "r-impl-constraint",
        text: "Always add a changelog entry.",
        class: "constraint",
        scope: { repo: "*", lane: "*", stage: ["implement"], kind: "chore", paths: [] },
      }),
      rule({
        id: "r-impl-guidance",
        text: "Prefer small helper functions.",
        class: "guidance",
        scope: { repo: "*", lane: "*", stage: ["implement"], kind: "*", paths: [] },
      }),
      rule({
        id: "r-review-constraint",
        text: "Cite a path:line for every finding.",
        class: "constraint",
        scope: { repo: "*", lane: "*", stage: ["review"], kind: "*", paths: [] },
      }),
      rule({
        id: "r-review-guidance",
        text: "Keep the tone terse.",
        class: "guidance",
        scope: { repo: "*", lane: "*", stage: ["review"], kind: "*", paths: [] },
      }),
    ];
    const implement = operatorRulesBlock(rules, "implement", "chore");
    expect(implement).toContain("r-impl-constraint");
    expect(implement).toContain("r-impl-guidance");
    expect(implement).not.toContain("r-review-constraint");
    expect(implement).not.toContain("r-review-guidance");

    const review = operatorRulesBlock(rules, "review", "chore");
    expect(review).toContain("r-review-constraint");
    expect(review).not.toContain("r-review-guidance");
    expect(review).not.toContain("r-impl-guidance");
    expect(review).not.toContain("r-impl-constraint");
  });

  it("drops repo:* rules first when over the 40-rule cap", () => {
    const rules: RuleRecord[] = [];
    for (let i = 0; i < 41; i++) {
      rules.push(
        rule({
          id: `r-star-${i}`,
          text: `Star rule ${i}.`,
          class: "constraint",
          scope: { repo: "*", lane: "*", stage: ["implement"], kind: "*", paths: [] },
        }),
      );
    }
    rules.push(
      rule({
        id: "r-specific",
        text: "Repo-specific constraint.",
        class: "constraint",
        scope: { repo: "/acme/widgets", lane: "*", stage: ["implement"], kind: "*", paths: [] },
      }),
    );
    const block = operatorRulesBlock(rules, "implement", "chore");
    expect(block).toContain("r-specific");
    expect(block.match(/r-star-/g)?.length).toBe(39);
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(6 * 1024);
  });

  it("omits paused and retired rules", () => {
    const rules = [
      rule({ id: "r-active", text: "Keep going.", class: "guidance" }),
      rule({ id: "r-paused", text: "Paused.", class: "guidance", status: "paused" }),
      rule({ id: "r-retired", text: "Retired.", class: "guidance", status: "retired" }),
    ];
    const block = operatorRulesBlock(rules, "implement", "chore");
    expect(block).toContain("r-active");
    expect(block).not.toContain("r-paused");
    expect(block).not.toContain("r-retired");
  });
});

describe("operator rules prompt marker", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = join(await mkdtemp(join(tmpdir(), "pi-sdlc-rules-prompt-")), "runs", "run-1");
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(runDir, "..", ".."), { recursive: true, force: true });
  });

  it("prompt still starts with generated marker", async () => {
    const block = operatorRulesBlock(
      [rule({ id: "r-one", text: "Always add a changelog entry.", class: "constraint" })],
      "implement",
      "chore",
    );
    const path = await writeStepPrompt(
      runDir,
      "implement",
      ["## OPERATOR RULES (binding)", "", block].join("\n"),
      0,
    );
    const text = await readFile(path, "utf8");
    expect(text.startsWith("<!-- pi-sdlc-factory generated")).toBe(true);
    expect(text).toContain("OPERATOR RULES (binding)");
    expect(text).toContain("r-one");
  });
});
