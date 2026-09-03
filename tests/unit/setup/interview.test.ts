import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAnswersFile,
  runGlobalInterview,
  runRepoInterview,
  type SetupUi,
} from "../../../src/setup/interview.js";

function uiFrom(answers: SetupAnswersLike): SetupUi {
  return {
    async select(title, options) {
      const v = answers[title];
      return typeof v === "string" ? v : options[0];
    },
    async input(title) {
      const v = answers[title];
      return typeof v === "string" ? v : "";
    },
    async confirm(title, initial = true) {
      const v = answers[title];
      return typeof v === "boolean" ? v : initial;
    },
  };
}
type SetupAnswersLike = Record<string, string | boolean | undefined>;

const sandboxProbe = { available: true, provider: "sandbox-exec" as const, detail: "ok" };

describe("readAnswersFile", () => {
  it("reads the headless JSON object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-answers-"));
    try {
      const path = join(dir, "answers.json");
      await writeFile(path, JSON.stringify({ sandbox: "off", steering: "never", maxLanes: 1 }));
      expect(await readAnswersFile(path)).toEqual({ sandbox: "off", steering: "never", maxLanes: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runGlobalInterview", () => {
  it("builds a FactoryConfig-shaped diff with sandbox under defaults, not operator", async () => {
    const result = await runGlobalInterview(uiFrom({}), {
      probes: { sandbox: sandboxProbe },
      answers: {
        coAuthoredBy: true,
        maxLanes: 1,
        maxLanesPerRepo: 1,
        sandbox: "off",
        steering: "never",
        planApproval: "never",
      },
    });
    expect(result.diff.operator).toMatchObject({ coAuthoredBy: true, maxLanes: 1, maxLanesPerRepo: 1 });
    expect(result.diff.operator).not.toHaveProperty("sandbox");
    expect(result.diff.defaults).toMatchObject({ sandbox: "off", steering: "never", planApproval: "never" });
    expect(result.diff.defaults).not.toHaveProperty("setupCommand");
    expect(result.answers.sandbox).toBe("off");
  });

  it("does not put interview answers on the diff object as an answers key", async () => {
    const result = await runGlobalInterview(uiFrom({}), {
      probes: { sandbox: { available: false, provider: null, detail: "missing" } },
      answers: { sandbox: "required" },
    });
    expect(result.diff).not.toHaveProperty("answers");
  });
});

describe("runRepoInterview", () => {
  it("registers the repo in repos[] and does not write operator.sandbox", async () => {
    const result = await runRepoInterview(uiFrom({}), "/repo", {
      probes: {
        git: { ok: true, repoRoot: "/repo", remotes: [{ name: "origin", url: "/bare.git" }] },
        defaultBranch: { branch: "main", source: "origin-head" },
        packageManager: { manager: "pnpm", lockfile: "pnpm-lock.yaml" },
        checks: { checks: [] },
      },
      answers: { tracker: "local", project: "fixture", label: "factory:ready" },
    });
    expect(result.diff.repos).toEqual([
      { path: "/repo", remote: "origin", tracker: "local", project: "fixture", label: "factory:ready" },
    ]);
    expect(result.diff.operator).toBeUndefined();
  });
});
