import { describe, it, expect } from "vitest";
import { completeFactoryArgs, type CompletionDeps } from "../../../src/commands/completions.js";

const deps: CompletionDeps = {
  lanes: ["chore", "bug"],
  repos: ["/repo-a", "/repo-b"],
  runs: [{ ref: "local-01ARZ", runId: "r1", lane: "chore", status: "waiting_user" }],
};

describe("completeFactoryArgs", () => {
  it("is synchronous and lists v0 verbs on an empty prefix", () => {
    const items = completeFactoryArgs("", deps);
    expect(items).not.toBeInstanceOf(Promise);
    expect(items?.map((i) => i.value)).toEqual(["setup", "enqueue", "start", "approve", "status"]);
    expect(items?.every((i) => !i.value.endsWith(" "))).toBe(true);
    expect(items?.every((i) => typeof i.description === "string")).toBe(true);
  });

  it("returns the full argument string for nested flags", () => {
    const kinds = completeFactoryArgs("enqueue --kind ", deps);
    expect(kinds?.map((i) => i.value)).toEqual([
      "enqueue --kind feature",
      "enqueue --kind enhancement",
      "enqueue --kind bug",
      "enqueue --kind chore",
    ]);
    const lanes = completeFactoryArgs("enqueue --lane c", deps);
    expect(lanes?.map((i) => i.value)).toEqual(["enqueue --lane chore"]);
  });

  it("completes approve/status refs from the snapshot, not from disk", () => {
    expect(completeFactoryArgs("approve ", deps)?.map((i) => i.value)).toEqual(["approve local-01ARZ"]);
    expect(completeFactoryArgs("status loc", deps)?.map((i) => i.value)).toEqual(["status local-01ARZ"]);
  });

  it("does not offer watch", () => {
    expect(completeFactoryArgs("w", deps)?.map((i) => i.value) ?? []).not.toContain("watch");
  });
});
