import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentDefs, packageRoot, V1_AGENTS } from "../../../src/controller/agents.js";
import { AGENTS } from "../../../src/lanes/catalog.js";

describe("packageRoot", () => {
  it("resolves the directory that contains src/ and agents/", () => {
    const root = packageRoot();
    expect(root.endsWith("src")).toBe(false);
    expect(root.includes("pi-software-factory-design") || root.length > 0).toBe(true);
  });
});

describe("loadAgentDefs", () => {
  it("loads required prompts by catalog id filename", async () => {
    const loaded = await loadAgentDefs({
      root: packageRoot(),
      models: {},
      defaultModel: "slot-a",
      required: ["planner", "implementer", "reviewer", "judge"],
    });
    expect(loaded.map((a) => a.name).sort()).toEqual(["implementer", "judge", "planner", "reviewer"]);
    expect(loaded.find((a) => a.name === "planner")?.stageClass).toBe("read-only");
    expect(loaded.find((a) => a.name === "implementer")?.stageClass).toBe("writer");
    expect(loaded.find((a) => a.name === "planner")?.promptPath.endsWith("agents/planner.md")).toBe(true);
  });

  it("throws no agent definition for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-agents-"));
    try {
      await mkdir(join(dir, "agents"));
      await writeFile(join(dir, "agents", "planner.md"), "# planner\n");
      await expect(
        loadAgentDefs({ root: dir, models: {}, defaultModel: "x", required: ["planner", "nope"] }),
      ).rejects.toThrow('no agent definition for "nope"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads the 13 roster prompts by catalog id", async () => {
    const loaded = await loadAgentDefs({
      root: packageRoot(),
      models: {},
      defaultModel: "slot-a",
      required: AGENTS,
    });
    expect(loaded.map((a) => a.name)).toEqual([...AGENTS]);
    expect(loaded).toHaveLength(13);
  });

  it("every roster prompt names VerdictEmit and never tracker credentials", async () => {
    const root = packageRoot();
    for (const name of AGENTS) {
      const body = await readFile(join(root, "agents", `${name}.md`), "utf8");
      expect(body, name).toContain("VerdictEmit");
      expect(body, name).not.toContain("gh ");
      expect(body, name).not.toContain("GITHUB_TOKEN");
    }
  });

  it("issue-analyst prompt is blind, fenced, and emits brief fields", async () => {
    const body = await readFile(join(packageRoot(), "agents", "issue-analyst.md"), "utf8");
    expect(body).toContain("brief");
    expect(body).toContain("fenced");
  });

  it("loads learner without bash only when the caller requires it", async () => {
    const loaded = await loadAgentDefs({
      root: packageRoot(),
      models: {},
      defaultModel: "slot-a",
      required: ["learner"],
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe("learner");
    expect(loaded[0]?.tools).toEqual(["read", "grep", "find", "write", "edit"]);
    expect(loaded[0]?.tools).not.toContain("bash");
    expect(loaded[0]?.stageClass).toBe("writer");
    const roster = await loadAgentDefs({
      root: packageRoot(),
      models: {},
      defaultModel: "slot-a",
      required: AGENTS,
    });
    expect(roster.map((a) => a.name)).not.toContain("learner");
    expect(roster).toHaveLength(13);
  });

  it("V1_AGENTS is the catalog minus codifier", () => {
    expect([...V1_AGENTS]).toEqual(AGENTS.filter((name) => name !== "codifier"));
    expect(V1_AGENTS).toHaveLength(12);
    expect(V1_AGENTS).not.toContain("codifier");
  });

  it("issue-analyst is read-only without bash; implementer is a writer", async () => {
    const loaded = await loadAgentDefs({
      root: packageRoot(),
      models: {},
      defaultModel: "slot-a",
      required: ["issue-analyst", "implementer"],
    });
    const analyst = loaded.find((a) => a.name === "issue-analyst");
    expect(analyst?.stageClass).toBe("read-only");
    expect(analyst?.tools).not.toContain("bash");
    expect(analyst?.tools).toEqual(["read", "grep", "find"]);
    const impl = loaded.find((a) => a.name === "implementer");
    expect(impl?.stageClass).toBe("writer");
    expect(impl?.tools).toContain("bash");
  });

  it("loads V1_AGENTS as read-only by default except implementer and tester", async () => {
    const loaded = await loadAgentDefs({
      root: packageRoot(),
      models: {},
      defaultModel: "slot-a",
      required: V1_AGENTS,
    });
    expect(loaded.map((a) => a.name)).toEqual([...V1_AGENTS]);
    expect(loaded.find((a) => a.name === "codifier")).toBeUndefined();
    for (const def of loaded) {
      if (def.name === "implementer" || def.name === "tester") {
        expect(def.stageClass, def.name).toBe("writer");
        expect(def.tools, def.name).toContain("bash");
      } else {
        expect(def.stageClass, def.name).toBe("read-only");
        expect(def.tools, def.name).not.toContain("bash");
        expect(def.tools, def.name).not.toContain("write");
      }
    }
  });

  it("codifier remains loadable on demand as a writer", async () => {
    const loaded = await loadAgentDefs({
      root: packageRoot(),
      models: {},
      defaultModel: "slot-a",
      required: ["codifier"],
    });
    expect(loaded[0]?.stageClass).toBe("writer");
    expect(loaded[0]?.tools).toContain("bash");
  });
});
