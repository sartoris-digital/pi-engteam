import { describe, expect, it } from "vitest";
import {
  mergeCollaborate,
  parseCollaboratePlan,
  validateCollaboratePlan,
  type CollaboratePlan,
  type CollaborateTask,
} from "../../../src/fusion/collaborate.js";
import type { SlotResult } from "../../../src/fusion/types.js";

const SLOTS = ["architect", "implementer"] as const;

function task(over: Partial<CollaborateTask> & Pick<CollaborateTask, "id">): Record<string, unknown> {
  return {
    assignee: "architect",
    dependsOn: [],
    files: [`src/${over.id}.ts`],
    verify: "pnpm test",
    description: `do ${over.id}`,
    ...over,
  };
}

function planOf(...tasks: Record<string, unknown>[]): { tasks: Record<string, unknown>[] } {
  return { tasks };
}

/** A 4-task diamond: t1 ∥ t2 → t3 → t4. */
function diamond(): { tasks: Record<string, unknown>[] } {
  return planOf(
    task({ id: "t1", assignee: "architect" }),
    task({ id: "t2", assignee: "implementer" }),
    task({ id: "t3", assignee: "implementer", dependsOn: ["t1", "t2"] }),
    task({ id: "t4", assignee: "architect", dependsOn: ["t3"] }),
  );
}

function slot(name: string, text: string): SlotResult {
  return { name, model: `model-${name}`, text };
}

function errorsOf(raw: unknown, names: readonly string[] = SLOTS): string[] {
  const result = validateCollaboratePlan(raw, names);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

function validPlan(raw: unknown, names: readonly string[] = SLOTS): CollaboratePlan {
  const result = validateCollaboratePlan(raw, names);
  if (!result.ok) throw new Error(`expected a valid plan, got: ${result.errors.join("; ")}`);
  return result.plan;
}

describe("validateCollaboratePlan — accepted DAG", () => {
  it("computes topological parallelism levels for a 4-task DAG", () => {
    const plan = validPlan(diamond());
    expect(plan.levels).toEqual([["t1", "t2"], ["t3"], ["t4"]]);
    expect(plan.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(plan.tasks[2]?.dependsOn).toEqual(["t1", "t2"]);
    expect(plan.tasks[0]?.files).toEqual(["src/t1.ts"]);
    expect(plan.tasks[0]?.verify).toBe("pnpm test");
  });

  it("puts every independent task on level 0", () => {
    const plan = validPlan(planOf(task({ id: "a" }), task({ id: "b", assignee: "implementer" })));
    expect(plan.levels).toEqual([["a", "b"]]);
  });

  it("treats a missing dependsOn as no dependencies", () => {
    const noDeps = { id: "solo", assignee: "architect", files: ["src/s.ts"], verify: "pnpm test", description: "d" };
    const plan = validPlan(planOf(noDeps, task({ id: "other", assignee: "implementer" })));
    expect(plan.levels).toEqual([["solo", "other"]]);
    expect(plan.tasks[0]?.dependsOn).toEqual([]);
  });
});

describe("validateCollaboratePlan — rejected plans", () => {
  it("reports a cycle with its path", () => {
    const errors = errorsOf(
      planOf(
        task({ id: "t1", dependsOn: ["t3"] }),
        task({ id: "t2", assignee: "implementer", dependsOn: ["t1"] }),
        task({ id: "t3", dependsOn: ["t2"] }),
      ),
    );
    const cycle = errors.find((e) => e.startsWith("dependency cycle:"));
    expect(cycle).toBeDefined();
    expect(cycle).toBe("dependency cycle: t1 -> t3 -> t2 -> t1");
  });

  it("reports a self-dependency without also blaming a cycle", () => {
    const errors = errorsOf(planOf(task({ id: "t1", dependsOn: ["t1"] }), task({ id: "t2", assignee: "implementer" })));
    expect(errors).toContain('task "t1" depends on itself');
    expect(errors.some((e) => e.startsWith("dependency cycle:"))).toBe(false);
  });

  it("rejects an unknown assignee", () => {
    const errors = errorsOf(planOf(task({ id: "t1", assignee: "reviewer" }), task({ id: "t2", assignee: "implementer" })));
    expect(errors).toContain('tasks[0].assignee "reviewer" is not one of the slots: architect, implementer');
  });

  it("rejects a plan that leaves a slot unassigned", () => {
    const errors = errorsOf(planOf(task({ id: "t1", assignee: "architect" })));
    expect(errors).toContain('slot "implementer" has no assigned task');
  });

  it("rejects a dangling dependsOn", () => {
    const errors = errorsOf(planOf(task({ id: "t1" }), task({ id: "t2", assignee: "implementer", dependsOn: ["nope"] })));
    expect(errors).toContain('task "t2" depends on unknown task "nope"');
  });

  it("rejects a duplicate task id", () => {
    const errors = errorsOf(planOf(task({ id: "t1" }), task({ id: "t1", assignee: "implementer" })));
    expect(errors).toContain('tasks[1].id duplicates task "t1"');
  });

  it.each([
    { name: "empty files array", files: [] },
    { name: "files with a blank entry", files: [""] },
    { name: "files that is not an array", files: "src/a.ts" },
    { name: "files with a non-string entry", files: [7] },
  ])("rejects $name", ({ files }) => {
    const errors = errorsOf(planOf(task({ id: "t1", files: files as never }), task({ id: "t2", assignee: "implementer" })));
    expect(errors).toContain("tasks[0].files must be a non-empty array of file paths");
  });

  it.each([
    { name: "missing verify", verify: undefined },
    { name: "blank verify", verify: "   " },
    { name: "non-string verify", verify: 3 },
  ])("rejects $name", ({ verify }) => {
    const errors = errorsOf(planOf(task({ id: "t1", verify: verify as never }), task({ id: "t2", assignee: "implementer" })));
    expect(errors).toContain("tasks[0].verify must be a non-empty command string");
  });

  it("rejects a blank id and a malformed dependsOn", () => {
    const errors = errorsOf(planOf(task({ id: "", assignee: "architect" }), task({ id: "t2", assignee: "implementer", dependsOn: "t1" as never })));
    expect(errors).toContain("tasks[0].id must be a non-empty string");
    expect(errors).toContain("tasks[1].dependsOn must be an array of task ids");
  });

  it.each([
    { name: "a non-object", raw: "not a plan", error: "plan must be a JSON object with a tasks array" },
    { name: "an array", raw: [], error: "plan must be a JSON object with a tasks array" },
    { name: "undefined (nothing parsed)", raw: undefined, error: "plan must be a JSON object with a tasks array" },
    { name: "a missing tasks array", raw: {}, error: "plan.tasks must be a non-empty array" },
    { name: "an empty tasks array", raw: { tasks: [] }, error: "plan.tasks must be a non-empty array" },
  ])("rejects $name", ({ raw, error }) => {
    expect(errorsOf(raw)).toEqual([error]);
  });

  it("collects every error rather than throwing on the first", () => {
    const errors = errorsOf(
      planOf(
        task({ id: "t1", assignee: "ghost", files: [], verify: "" }),
        task({ id: "t1", assignee: "ghost", dependsOn: ["missing"] }),
      ),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'tasks[0].assignee "ghost" is not one of the slots: architect, implementer',
        "tasks[0].files must be a non-empty array of file paths",
        "tasks[0].verify must be a non-empty command string",
        'tasks[1].id duplicates task "t1"',
        'task "t1" depends on unknown task "missing"',
        'slot "architect" has no assigned task',
        'slot "implementer" has no assigned task',
      ]),
    );
    expect(errors.length).toBeGreaterThanOrEqual(7);
  });
});

describe("parseCollaboratePlan", () => {
  it("extracts a ```json fenced block", () => {
    const text = ["Here is the plan.", "", "```json", JSON.stringify(diamond(), null, 2), "```", "", "Happy to revise."].join("\n");
    expect(parseCollaboratePlan(text)).toEqual(diamond());
  });

  it("extracts an unlabelled fenced block", () => {
    const text = ["```", JSON.stringify(diamond()), "```"].join("\n");
    expect(parseCollaboratePlan(text)).toEqual(diamond());
  });

  it("parses bare JSON", () => {
    expect(parseCollaboratePlan(JSON.stringify(diamond()))).toEqual(diamond());
  });

  it("parses JSON surrounded by prose", () => {
    const text = `I propose the following.\n\n${JSON.stringify(diamond())}\n\nThat covers it.`;
    expect(parseCollaboratePlan(text)).toEqual(diamond());
  });

  it("ignores braces inside strings when slicing an embedded object", () => {
    const raw = { tasks: [{ id: "t1", description: "handle } and { in prose" }] };
    expect(parseCollaboratePlan(`prose { not json\n${JSON.stringify(raw)}\ntrailing }`)).toEqual(raw);
  });

  it("prefers the fenced block over surrounding prose objects", () => {
    const text = ["{\"tasks\": []}", "```json", JSON.stringify(diamond()), "```"].join("\n");
    expect(parseCollaboratePlan(text)).toEqual(diamond());
  });

  it.each([
    { name: "empty text", text: "" },
    { name: "whitespace", text: "   \n  " },
    { name: "prose with no JSON", text: "I could not produce a plan." },
    { name: "malformed JSON", text: "```json\n{ tasks: [ }\n```" },
  ])("returns undefined for $name", ({ text }) => {
    expect(parseCollaboratePlan(text)).toBeUndefined();
  });
});

describe("mergeCollaborate", () => {
  it("PASSes with a markdown task table and raw plan.json", () => {
    const result = mergeCollaborate([
      slot("architect", `Plan:\n\`\`\`json\n${JSON.stringify(diamond())}\n\`\`\``),
      slot("implementer", "no plan here"),
    ]);
    expect(result.verdict).toBe("PASS");
    expect(result.issues ?? []).toEqual([]);
    const markdown = result.artifacts?.collaborate ?? "";
    expect(markdown).toContain("| task | owner | depends on | files | verify |");
    expect(markdown).toContain("| t3 | implementer | t1, t2 | src/t3.ts | pnpm test |");
    expect(markdown).toContain("| t1 | architect | — | src/t1.ts | pnpm test |");
    expect(markdown).toContain("proposed by [architect]");
    expect(markdown).toContain("1) t1 ∥ t2");
    const raw: unknown = JSON.parse(result.artifacts?.["plan.json"] ?? "null");
    expect((raw as CollaboratePlan).levels).toEqual([["t1", "t2"], ["t3"], ["t4"]]);
    expect((raw as CollaboratePlan).tasks).toHaveLength(4);
  });

  it("falls through to a later slot when the first proposal is invalid", () => {
    const broken = planOf(task({ id: "t1", assignee: "ghost" }));
    const result = mergeCollaborate([
      slot("architect", JSON.stringify(broken)),
      slot("implementer", JSON.stringify(diamond())),
    ]);
    expect(result.verdict).toBe("PASS");
    expect(result.artifacts?.collaborate ?? "").toContain("proposed by [implementer]");
  });

  it("FAILs closed with every slot's validation errors when no plan is valid", () => {
    const cyclic = planOf(
      task({ id: "t1", dependsOn: ["t2"] }),
      task({ id: "t2", assignee: "implementer", dependsOn: ["t1"] }),
    );
    const result = mergeCollaborate([slot("architect", "I refuse to plan."), slot("implementer", JSON.stringify(cyclic))]);
    expect(result.verdict).toBe("FAIL");
    expect(result.artifacts).toBeUndefined();
    expect(result.issues).toContain("[architect] plan must be a JSON object with a tasks array");
    expect(result.issues).toContain("[implementer] dependency cycle: t1 -> t2 -> t1");
  });

  it("FAILs when there are no slots at all", () => {
    const result = mergeCollaborate([]);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toEqual(["no slot produced a collaborate plan"]);
  });

  it("requires the plan to assign work to every surviving slot", () => {
    const oneSided = planOf(task({ id: "t1", assignee: "architect" }));
    const result = mergeCollaborate([slot("architect", JSON.stringify(oneSided)), slot("implementer", "")]);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain('[architect] slot "implementer" has no assigned task');
  });
});
