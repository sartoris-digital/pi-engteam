import { describe, it, expect } from "vitest";
import { parseFactoryArgs, SUBCOMMANDS } from "../../../src/commands/router.js";

export const V1_SUBCOMMANDS = [
  "setup",
  "config",
  "lanes",
  "rules",
  "remember",
  "forget",
  "secret",
  "grill",
  "watch",
  "interrupt",
  "start",
  "stop",
  "status",
  "doctor",
  "enqueue",
  "classify",
  "resume",
  "approve",
  "grant",
  "replan",
  "cancel",
  "drop",
  "retry",
  "rescan",
  "reconcile",
  "landed",
  "closed",
  "gc",
  "rebase",
] as const;

describe("parseFactoryArgs", () => {
  it("lists the v1 subcommand tree without codify", () => {
    expect([...SUBCOMMANDS]).toEqual([...V1_SUBCOMMANDS]);
    expect(SUBCOMMANDS).not.toContain("codify");
    expect(SUBCOMMANDS).not.toContain("codified");
  });

  it("parses enqueue with quoted --task and string flags", () => {
    const parsed = parseFactoryArgs(
      `enqueue --task "add a greeting helper" --repo /tmp/repo --kind chore`,
    );
    expect(parsed.verb).toBe("enqueue");
    expect(parsed.flags.task).toBe("add a greeting helper");
    expect(parsed.flags.repo).toBe("/tmp/repo");
    expect(parsed.flags.kind).toBe("chore");
    expect(parsed.args).toEqual([]);
    expect(parsed.error).toBeUndefined();
  });

  it("parses approve ref plus trailing notes and --waive", () => {
    const parsed = parseFactoryArgs(`approve local-01ARZ --waive r-builtin-no-generated-docs looks right to me`);
    expect(parsed.verb).toBe("approve");
    expect(parsed.args).toEqual(["local-01ARZ", "looks", "right", "to", "me"]);
    expect(parsed.flags.waive).toBe("r-builtin-no-generated-docs");
  });

  it("parses boolean flags and setup --answers", () => {
    expect(parseFactoryArgs("start --now").flags.now).toBe(true);
    expect(parseFactoryArgs("setup --answers /tmp/a.json").flags.answers).toBe("/tmp/a.json");
    expect(parseFactoryArgs("setup /repo").args).toEqual(["/repo"]);
  });

  it("accepts v1 verbs including watch and rejects unknown verbs with the v1 set", () => {
    expect(parseFactoryArgs("watch local-1").verb).toBe("watch");
    expect(parseFactoryArgs("grant r1").verb).toBe("grant");
    expect(parseFactoryArgs("remember --global always add a changelog").verb).toBe("remember");
    const parsed = parseFactoryArgs("codify");
    expect(parsed.verb).toBeNull();
    expect(parsed.error).toMatch(/unknown subcommand codify/);
    expect(parsed.error).toContain(V1_SUBCOMMANDS.join("|"));
    expect(parsed.error).not.toMatch(/setup\|enqueue\|start\|approve\|status\|landed\|closed\|reconcile$/);
    expect(parseFactoryArgs("").verb).toBeNull();
  });
});
