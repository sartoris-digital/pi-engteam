import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { GitHubAdapter } from "../../../src/trackers/github.js";
import { globalConfigPath } from "../../../src/config/layers.js";
import {
  GITHUB_FIXTURE_ISSUE,
  GITHUB_FIXTURE_LABELER,
  GITHUB_FIXTURE_REPO,
  makeGithubFactoryWorld,
} from "../../helpers/github-fixture.js";

describe("makeGithubFactoryWorld", () => {
  it("registers a labelled GitHub ticket on a bare remote and cleans up", async () => {
    const world = await makeGithubFactoryWorld();
    try {
      expect(world.adapter).toBeInstanceOf(GitHubAdapter);
      expect(world.issueRef).toEqual({
        tracker: "github",
        id: `${GITHUB_FIXTURE_REPO}#${GITHUB_FIXTURE_ISSUE}`,
      });

      const cfg = JSON.parse(await readFile(globalConfigPath(world.home), "utf8")) as {
        repos?: Array<{ tracker?: string; remote?: string; path?: string }>;
        operator?: { trackers?: Array<{ kind?: string }> };
      };
      expect(cfg.repos?.[0]?.tracker).toBe("github");
      expect(cfg.repos?.[0]?.remote).toBe("origin");
      expect(cfg.repos?.[0]?.path).toBe(world.fixture.repo);
      expect((await world.fixture.git(["remote", "get-url", "origin"])).stdout.trim()).toBe(world.fixture.bare);
      expect(cfg.operator?.trackers?.some((t) => t.kind === "github")).toBe(true);

      const ticket = await world.adapter.fetch(world.issueRef);
      expect(ticket.ref).toEqual(world.issueRef);
      expect(ticket.labels).toContain("factory:ready");
      expect(ticket.body.length).toBeGreaterThanOrEqual(80);
      expect(ticket.body.toLowerCase()).toMatch(/accept|greet/);
      expect(ticket.author).toBe(GITHUB_FIXTURE_LABELER);

      const labeler = await world.adapter.labelerOf(world.issueRef, "factory:ready");
      expect(labeler?.login).toBe(GITHUB_FIXTURE_LABELER);
      expect(await world.adapter.isAuthorized(GITHUB_FIXTURE_LABELER)).toBe(true);

      expect(world.analyst).toBeDefined();
      const sample = await world.analyst.sample({ blindedTicket: "x", slot: "A" });
      expect(sample.kind).toBe("chore");
      expect(sample.confidence).toBe("HIGH");
      expect(sample.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);

      const home = world.home;
      const root = world.fixture.root;
      await world.cleanup();
      await world.cleanup();
      await expect(stat(home)).rejects.toThrow();
      await expect(stat(root)).rejects.toThrow();
      await expect(stat(join(home, "factory.json"))).rejects.toThrow();
    } finally {
      await world.cleanup();
    }
  }, 60_000);

  it("issue 42 is fetchable through GitHubAdapter without a real gh", async () => {
    const world = await makeGithubFactoryWorld();
    try {
      const listed = await world.adapter.list({ label: "factory:ready", state: "open" });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.ref.id).toBe(`${GITHUB_FIXTURE_REPO}#${GITHUB_FIXTURE_ISSUE}`);
      expect(world.gh.calls?.some((argv) => argv[0] === "issue" && argv[1] === "view")).toBe(false);
      await world.adapter.fetch(world.issueRef);
      expect(world.gh.calls?.some((argv) => argv[0] === "issue" && argv[1] === "view")).toBe(true);
    } finally {
      await world.cleanup();
    }
  }, 60_000);
});
