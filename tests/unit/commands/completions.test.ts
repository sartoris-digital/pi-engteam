import { describe, it, expect } from "vitest";
import { completeFactoryArgs, type CompletionDeps } from "../../../src/commands/completions.js";
import { SUBCOMMANDS } from "../../../src/commands/router.js";

const deps: CompletionDeps = {
  lanes: ["chore", "bug"],
  repos: ["/repo-a", "/repo-b"],
  runs: [
    { ref: "local-01ARZ", runId: "r1", lane: "chore", status: "awaiting-steer" },
    { ref: "local-pub", runId: "r2", lane: "chore", status: "published" },
    { ref: "local-grant", runId: "r3", lane: "bug", status: "approval-needed" },
  ],
  secretNames: ["ACME_TOKEN", "repo/acme/GH_TOKEN"],
};

describe("completeFactoryArgs", () => {
  it("is synchronous and lists v1 verbs on an empty prefix", () => {
    const items = completeFactoryArgs("", deps);
    expect(items).not.toBeInstanceOf(Promise);
    expect(items?.map((i) => i.value)).toEqual([...SUBCOMMANDS]);
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
    expect(completeFactoryArgs("enqueue --priority ", deps)?.map((i) => i.value)).toEqual([
      "enqueue --priority p0",
      "enqueue --priority p1",
      "enqueue --priority p2",
      "enqueue --priority p3",
    ]);
  });

  it("completes approve only for awaiting-steer and grant only for approval-needed", () => {
    expect(completeFactoryArgs("approve ", deps)?.map((i) => i.value)).toEqual(["approve local-01ARZ"]);
    expect(completeFactoryArgs("grant ", deps)?.map((i) => i.value)).toEqual(["grant local-grant"]);
    expect(completeFactoryArgs("status loc", deps)?.map((i) => i.value)).toEqual([
      "status local-01ARZ",
      "status local-pub",
      "status local-grant",
    ]);
  });

  it("offers watch and secret verbs then vault names, never values", () => {
    expect(completeFactoryArgs("w", deps)?.map((i) => i.value)).toContain("watch");
    expect(completeFactoryArgs("secret ", deps)?.map((i) => i.value)).toEqual([
      "secret set",
      "secret list",
      "secret rm",
      "secret rotate",
      "secret bind",
      "secret export",
      "secret import",
      "secret scrub",
    ]);
    const names = completeFactoryArgs("secret rm ", deps)?.map((i) => i.value) ?? [];
    expect(names).toEqual(["secret rm ACME_TOKEN", "secret rm repo/acme/GH_TOKEN"]);
    expect(JSON.stringify(names)).not.toMatch(/ghp_|sk-|value/i);
    const bind = completeFactoryArgs("secret bind ", { ...deps, unboundNames: ["secret:UNBOUND_1"] })?.map((i) => i.value) ?? [];
    expect(bind).toEqual(["secret bind secret:UNBOUND_1"]);
    expect(JSON.stringify(bind)).not.toMatch(/ghp_|sk-|tok-|value/i);
  });

  it("completes codify/codified verbs and promote name@version, never secret values", () => {
    expect(completeFactoryArgs("", deps)?.map((i) => i.value)).toEqual([...SUBCOMMANDS]);
    expect(completeFactoryArgs("codi", deps)?.map((i) => i.value)).toEqual(["codify", "codified"]);
    expect(completeFactoryArgs("codified ", deps)?.map((i) => i.value)).toEqual([
      "codified list",
      "codified explain",
      "codified why",
      "codified promote",
      "codified demote",
      "codified retire",
      "codified retry",
      "codified shadow",
      "codified diff",
    ]);
    const promote =
      completeFactoryArgs("codified promote ", {
        ...deps,
        codifiedPromote: ["bump-package-version@1"],
      })?.map((i) => i.value) ?? [];
    expect(promote).toEqual(["codified promote bump-package-version@1"]);
    expect(JSON.stringify(promote)).not.toMatch(/ghp_|sk-|value/i);
  });
});
