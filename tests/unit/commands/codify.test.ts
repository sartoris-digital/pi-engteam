import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { runCodify } from "../../../src/commands/codify.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

function depsFor(home: string): FactoryDeps {
  return {
    home,
    runsDir: join(home, "runs"),
    projectRootDefault: "/pkg",
    engine: {},
    executor: {},
    provider: {},
    tracker: {},
    agents: [],
    lanes: {},
    piBinary: "pi",
    repos: [],
  } as unknown as FactoryDeps;
}

describe("parseFactoryArgs codify", () => {
  it("parses --scan, --gaps, --repair, and ref:stage", () => {
    expect(parseFactoryArgs("codify --scan")).toMatchObject({
      verb: "codify",
      flags: { scan: true },
      args: [],
    });
    expect(parseFactoryArgs("codify --gaps")).toMatchObject({
      verb: "codify",
      flags: { gaps: true },
    });
    const repair = parseFactoryArgs("codify --repair bump-package-version");
    expect(repair.verb).toBe("codify");
    expect(repair.flags.repair).toBe("bump-package-version");
    const onDemand = parseFactoryArgs("codify run-bump-1:implement");
    expect(onDemand.verb).toBe("codify");
    expect(onDemand.args).toEqual(["run-bump-1:implement"]);
  });
});

describe("runCodify", () => {
  it("requires a target, --scan, --gaps, or --repair", async () => {
    await withTmpHome(async (home) => {
      await expect(runCodify(parseFactoryArgs("codify"), depsFor(home))).rejects.toThrow(
        /scan|gaps|repair|ref/i,
      );
    });
  });

  it("--scan with an empty inbox reports zero candidates", async () => {
    await withTmpHome(async (home) => {
      await mkdir(join(home, "runs", "_factory", "codify"), { recursive: true, mode: 0o700 });
      const out = await runCodify(parseFactoryArgs("codify --scan"), depsFor(home));
      expect(out).toMatch(/0 candidate/i);
    });
  });
});
