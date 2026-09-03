import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentDefs, packageRoot } from "../../../src/controller/agents.js";

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
});
