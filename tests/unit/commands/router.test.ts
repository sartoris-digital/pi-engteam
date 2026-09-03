import { describe, it, expect } from "vitest";
import { parseFactoryArgs, SUBCOMMANDS } from "../../../src/commands/router.js";

describe("parseFactoryArgs", () => {
  it("lists the v0 watch-less subcommands", () => {
    expect([...SUBCOMMANDS]).toEqual(["setup", "enqueue", "start", "approve", "status"]);
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

  it("rejects unknown verbs including watch", () => {
    const parsed = parseFactoryArgs("watch local-1");
    expect(parsed.verb).toBeNull();
    expect(parsed.error).toMatch(/unknown subcommand watch/);
    expect(parseFactoryArgs("").verb).toBeNull();
  });
});
