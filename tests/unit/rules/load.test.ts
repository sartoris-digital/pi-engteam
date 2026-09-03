import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTmpHome } from "../../helpers/tmp-home.js";
import { loadEffectiveRules } from "../../../src/rules/load.js";
import { BUILTIN_RULES } from "../../../src/rules/schema.js";

async function writeYaml(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
}

describe("loadEffectiveRules", () => {
  it("includes the locked builtin no-generated-docs rule", async () => {
    await withTmpHome(async (home) => {
      const loaded = await loadEffectiveRules({ home });
      const builtin = loaded.rules.find((r) => r.id === "r-builtin-no-generated-docs");
      expect(builtin?.status).toBe("locked");
      expect(builtin?.text).toMatch(/generated planning artifacts/i);
      expect(BUILTIN_RULES.some((r) => r.id === "r-builtin-no-generated-docs" && r.status === "locked")).toBe(true);
      expect(loaded.sha).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("lets a local file override a global rule by id, but cannot pause a locked builtin", async () => {
    await withTmpHome(async (home) => {
      const repo = join(home, "repo");
      await mkdir(join(repo, ".pi"), { recursive: true });
      await writeYaml(
        join(home, "rules.yaml"),
        [
          "schemaVersion: 1",
          "rules:",
          "  - id: r-20260902-changelog",
          "    text: Every PR adds a CHANGELOG.md entry under Unreleased.",
          "    scope: { repo: '*', lane: '*', stage: [implement, review], kind: '*', paths: [] }",
          "    class: constraint",
          "    enforce: [prompt, review]",
          "    createdAt: 2026-09-02T18:40:00Z",
          "    author: operator",
          "    status: active",
          "",
        ].join("\n"),
      );
      await writeYaml(
        join(repo, ".pi", "factory-rules.local.yaml"),
        [
          "schemaVersion: 1",
          "rules:",
          "  - id: r-20260902-changelog",
          "    text: Every PR adds a CHANGELOG.md entry describing the user-visible change.",
          "    scope: { repo: '*', lane: '*', stage: [implement], kind: '*', paths: [] }",
          "    class: constraint",
          "    enforce: [prompt]",
          "    createdAt: 2026-09-02T18:40:00Z",
          "    author: operator",
          "    status: paused",
          "  - id: r-builtin-no-generated-docs",
          "    text: try to pause the builtin",
          "    scope: { repo: '*', lane: '*', stage: [implement], kind: '*', paths: [] }",
          "    class: constraint",
          "    enforce: [prompt]",
          "    createdAt: 2026-09-02T18:40:00Z",
          "    author: operator",
          "    status: paused",
          "",
        ].join("\n"),
      );

      const loaded = await loadEffectiveRules({ home, repoPath: repo });
      const changelog = loaded.rules.find((r) => r.id === "r-20260902-changelog");
      expect(changelog?.text).toMatch(/user-visible change/);
      expect(changelog?.status).toBe("paused");
      expect(changelog?.scope.stage).toEqual(["implement"]);

      const builtin = loaded.rules.find((r) => r.id === "r-builtin-no-generated-docs");
      expect(builtin?.status).toBe("locked");
      expect(builtin?.text).not.toBe("try to pause the builtin");
    });
  });

  it("does not merge a committed-looking factory-rules.yaml", async () => {
    await withTmpHome(async (home) => {
      const repo = join(home, "repo");
      await mkdir(join(repo, ".pi"), { recursive: true });
      await writeYaml(
        join(repo, ".pi", "factory-rules.yaml"),
        [
          "schemaVersion: 1",
          "rules:",
          "  - id: r-committed-should-not-load",
          "    text: This committed rule must never be merged.",
          "    scope: { repo: '*', lane: '*', stage: [implement], kind: '*', paths: [] }",
          "    class: guidance",
          "    enforce: [prompt]",
          "    createdAt: 2026-09-02T18:40:00Z",
          "    author: operator",
          "    status: active",
          "",
        ].join("\n"),
      );
      const loaded = await loadEffectiveRules({ home, repoPath: repo });
      expect(loaded.rules.map((r) => r.id)).not.toContain("r-committed-should-not-load");
    });
  });

  it("overlays repos[].rules between global and local", async () => {
    await withTmpHome(async (home) => {
      const repo = join(home, "repo");
      await mkdir(join(repo, ".pi"), { recursive: true });
      await writeYaml(
        join(home, "rules.yaml"),
        [
          "schemaVersion: 1",
          "rules:",
          "  - id: r-from-global",
          "    text: Global wording.",
          "    scope: { repo: '*', lane: '*', stage: [implement], kind: '*', paths: [] }",
          "    class: guidance",
          "    enforce: [prompt]",
          "    createdAt: 2026-09-02T18:40:00Z",
          "    author: operator",
          "    status: active",
          "",
        ].join("\n"),
      );
      const loaded = await loadEffectiveRules({
        home,
        repoPath: repo,
        reposEntryRules: [
          {
            id: "r-from-global",
            text: "Registry wording.",
            scope: { repo: "*", lane: "*", stage: ["implement"], kind: "*", paths: [] },
            class: "guidance",
            enforce: ["prompt"],
            createdAt: "2026-09-02T18:40:00Z",
            author: "operator",
            status: "active",
          },
        ],
      });
      expect(loaded.rules.find((r) => r.id === "r-from-global")?.text).toBe("Registry wording.");
    });
  });
});
