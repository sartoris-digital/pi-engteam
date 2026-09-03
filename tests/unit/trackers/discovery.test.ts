import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../../../src/controller/agents.js";
import { buildFactoryDeps } from "../../../src/controller/register.js";
import { LocalAdapter } from "../../../src/trackers/local.js";
import {
  buildTrackerRegistry,
  detectTrackerFromRemote,
} from "../../../src/trackers/discovery.js";
import { makeStubGh } from "../../helpers/stub-gh.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

describe("detectTrackerFromRemote", () => {
  it("parses ssh and https GitHub remotes", () => {
    expect(detectTrackerFromRemote("git@github.com:acme/widgets.git")).toEqual({
      kind: "github",
      owner: "acme",
      repo: "widgets",
    });
    expect(detectTrackerFromRemote("https://github.com/acme/widgets.git")).toEqual({
      kind: "github",
      owner: "acme",
      repo: "widgets",
    });
    expect(detectTrackerFromRemote("https://github.com/acme/widgets")).toEqual({
      kind: "github",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("rejects GitLab and Azure remotes", () => {
    expect(detectTrackerFromRemote("git@gitlab.com:acme/widgets.git")).toBeNull();
    expect(detectTrackerFromRemote("https://gitlab.com/acme/widgets.git")).toBeNull();
    expect(detectTrackerFromRemote("https://dev.azure.com/org/project/_git/widgets")).toBeNull();
  });
});

describe("buildTrackerRegistry", () => {
  let runsDir: string;

  afterEach(async () => {
    if (runsDir !== undefined) await rm(runsDir, { recursive: true, force: true });
  });

  it("always includes local and adds github only when configured", async () => {
    runsDir = await mkdtemp(join(tmpdir(), "sdlc-reg-"));
    const local = new LocalAdapter(runsDir);
    const empty = buildTrackerRegistry({ local });
    expect(empty.get("local")).toBe(local);
    expect(empty.has("github")).toBe(false);

    const withTrackersOnly = buildTrackerRegistry({
      local,
      trackers: [{ id: "gh", kind: "github" }],
    });
    expect(withTrackersOnly.has("github")).toBe(false);

    const withGithub = buildTrackerRegistry({
      local,
      github: { exec: makeStubGh({}), repo: "acme/widgets" },
      trackers: [{ id: "gh", kind: "github" }],
    });
    expect(withGithub.get("local")).toBe(local);
    expect(withGithub.get("github")?.id).toBe("github");
  });
});

describe("buildFactoryDeps adapters", () => {
  it("still exposes tracker as LocalAdapter and registers the local adapter", async () => {
    await withTmpHome(async () => {
      const deps = await buildFactoryDeps();
      expect(deps.tracker).toBeInstanceOf(LocalAdapter);
      expect(deps.tracker.id).toBe("local");
      expect(deps.adapters?.get("local")).toBe(deps.tracker);
      expect(deps.adapters?.has("github")).toBe(false);
    });
  });
});

describe("tracker skills", () => {
  it("ships GitHub, Azure DevOps, and Jira skill files with tracker frontmatter", async () => {
    const root = packageRoot();
    const gh = await readFile(join(root, "skills", "factory-github", "SKILL.md"), "utf8");
    const ado = await readFile(join(root, "skills", "factory-azure-devops", "SKILL.md"), "utf8");
    const jira = await readFile(join(root, "skills", "factory-jira", "SKILL.md"), "utf8");
    expect(gh).toMatch(/pi-sdlc-factory-tracker:\s*github/);
    expect(ado).toMatch(/pi-sdlc-factory-tracker:\s*azure-devops/);
    expect(jira).toMatch(/pi-sdlc-factory-tracker:\s*jira/);
  });
});
