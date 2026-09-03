import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runForget } from "../../../src/commands/forget.js";
import { runRemember } from "../../../src/commands/remember.js";
import { runRules } from "../../../src/commands/rules.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { LOCAL_RULES_EXCLUDE } from "../../../src/rules/remember.js";
import { LocalAdapter } from "../../../src/trackers/local.js";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { withTmpHome } from "../../helpers/tmp-home.js";
import type { ParsedFactoryArgs } from "../../../src/commands/router.js";

function parsed(over: Partial<ParsedFactoryArgs> & { args: string[] }): ParsedFactoryArgs {
  return { verb: "status", flags: {}, ...over };
}

function depsFor(home: string, repos: string[]): FactoryDeps {
  const runs = join(home, "runs");
  return {
    home,
    runsDir: runs,
    projectRootDefault: "/pkg",
    engine: {} as FactoryDeps["engine"],
    executor: {} as FactoryDeps["executor"],
    provider: {} as FactoryDeps["provider"],
    tracker: new LocalAdapter(runs),
    agents: [],
    lanes: { chore: {} as FactoryDeps["lanes"][string] },
    piBinary: "pi",
    repos,
  };
}

describe("runRemember / runForget / runRules", () => {
  it("writes factory-rules.local.yaml and appends it to .git/info/exclude", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        const record = await runRemember(
          parsed({ args: ["always add a changelog entry"], flags: { repo: fixture.repo } }),
          depsFor(home, [fixture.repo]),
        );
        const yaml = await readFile(join(fixture.repo, ".pi", "factory-rules.local.yaml"), "utf8");
        expect(yaml).toContain(record.id);
        expect(yaml).toMatch(/changelog/i);
        const exclude = await readFile(join(fixture.repo, ".git", "info", "exclude"), "utf8");
        expect(exclude.split(/\r?\n/).map((l) => l.trim())).toContain(LOCAL_RULES_EXCLUDE);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("throws on forget of a locked builtin", async () => {
    await withTmpHome(async (home) => {
      await expect(
        runForget(parsed({ args: ["r-builtin-no-generated-docs"] }), depsFor(home, [])),
      ).rejects.toThrow(/locked/i);
    });
  });

  it("runRules --explain prints provenance", async () => {
    await withTmpHome(async (home) => {
      const text = await runRules(parsed({ args: [], flags: { explain: true } }), depsFor(home, []));
      expect(text).toContain("r-builtin-no-generated-docs");
      expect(text).toContain("builtin");
      expect(text).toContain("locked");
    });
  });

  it("headless remember without --repo/--global when cwd is unregistered throws", async () => {
    await withTmpHome(async (home) => {
      await expect(
        runRemember(parsed({ args: ["always add a changelog entry"], flags: {} }), depsFor(home, ["/not-cwd"])),
      ).rejects.toThrow(/--repo|--global/i);
    });
  });
});
