import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_EXPERTISE_CONFIG,
  appendExpertise,
  readExpertise,
  readReadonly,
  trackAndMaybePromote,
  verdictToWisdom,
  type ExpertiseConfig,
  type ExpertiseDirs,
} from "../../../src/memory/ExpertiseStore.js";

let dirs: ExpertiseDirs;
let cfg: ExpertiseConfig;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "expertise-"));
  dirs = {
    globalDir: join(root, "global"),
    projectDir: join(root, "project"),
  };
  cfg = {
    ...DEFAULT_EXPERTISE_CONFIG,
    globalDir: dirs.globalDir,
    maxLinesPerFile: 50,
    promoteThresholdProjects: 2,
  };
});

describe("ExpertiseStore — Phase 5 §8", () => {
  it("verdictToWisdom flattens learnings/decisions/issues_found/gotchas", () => {
    const out = verdictToWisdom({
      learnings: ["a"],
      decisions: ["b"],
      issues_found: ["c"],
      gotchas: ["d"],
    });
    expect(out).toEqual([
      { kind: "learning", text: "a" },
      { kind: "decision", text: "b" },
      { kind: "issue_found", text: "c" },
      { kind: "gotcha", text: "d" },
    ]);
  });

  it("appendExpertise dedupes against existing entries", async () => {
    const first = await appendExpertise(
      "engineer",
      dirs,
      [{ kind: "learning", text: "needs trust proxy" }],
      cfg,
    );
    expect(first).toHaveLength(1);
    const second = await appendExpertise(
      "engineer",
      dirs,
      [
        { kind: "learning", text: "needs trust proxy" },
        { kind: "learning", text: "use express-async-errors" },
      ],
      cfg,
    );
    expect(second).toHaveLength(1);
    expect(second[0].text).toBe("use express-async-errors");
    const raw = await readFile(join(dirs.projectDir, "engineer.md"), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("appendExpertise enforces max line cap by pruning oldest", async () => {
    const tinyCfg = { ...cfg, maxLinesPerFile: 3 };
    await appendExpertise(
      "engineer",
      dirs,
      [
        { kind: "learning", text: "first" },
        { kind: "learning", text: "second" },
        { kind: "learning", text: "third" },
        { kind: "learning", text: "fourth" },
      ],
      tinyCfg,
    );
    const raw = await readFile(join(dirs.projectDir, "engineer.md"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("second");
    expect(lines[2]).toContain("fourth");
  });

  it("rejects unsafe agent names", async () => {
    await expect(
      appendExpertise("../etc/passwd", dirs, [{ kind: "learning", text: "x" }], cfg),
    ).rejects.toThrow(/unsafe agent name/);
  });

  it("readExpertise returns empty when no files exist", async () => {
    const out = await readExpertise("engineer", dirs);
    expect(out).toBe("");
  });

  it("readExpertise renders both project-local and user-global sections", async () => {
    await mkdir(dirs.globalDir, { recursive: true });
    await mkdir(dirs.projectDir, { recursive: true });
    await writeFile(join(dirs.globalDir, "engineer.md"), "- [learning] global lesson\n");
    await writeFile(join(dirs.projectDir, "engineer.md"), "- [learning] local lesson\n");
    const out = await readExpertise("engineer", dirs);
    expect(out).toContain("## Expertise");
    expect(out).toContain("### From this project");
    expect(out).toContain("local lesson");
    expect(out).toContain("### Global");
    expect(out).toContain("global lesson");
  });

  it("readReadonly only includes files that match the agent in frontmatter", async () => {
    const ro = join(dirs.projectDir, "_readonly");
    await mkdir(ro, { recursive: true });
    await writeFile(
      join(ro, "billing.md"),
      `---\nagents: ["implementer"]\nloadOrder: 0\n---\n# Billing Flow\nbody`,
    );
    await writeFile(
      join(ro, "deploy.md"),
      `---\nagents: ["devops"]\n---\n# Deploy\nbody`,
    );
    await writeFile(
      join(ro, "open.md"),
      `# Open Doc\nopen body`,
    );

    const impl = await readReadonly("implementer", dirs);
    expect(impl).toContain("Billing Flow");
    expect(impl).toContain("Open Doc");
    expect(impl).not.toContain("Deploy");

    const dev = await readReadonly("devops", dirs);
    expect(dev).toContain("Deploy");
    expect(dev).toContain("Open Doc");
    expect(dev).not.toContain("Billing Flow");
  });

  it("trackAndMaybePromote promotes after threshold projects", async () => {
    const entry = { kind: "learning" as const, text: "shared lesson" };
    // First project — not promoted.
    const r1 = await trackAndMaybePromote("engineer", cfg, "/tmp/proj-a", [entry]);
    expect(r1).toHaveLength(0);
    // Second project — meets threshold (2).
    const r2 = await trackAndMaybePromote("engineer", cfg, "/tmp/proj-b", [entry]);
    expect(r2).toHaveLength(1);
    const globalRaw = await readFile(join(cfg.globalDir, "engineer.md"), "utf8");
    expect(globalRaw).toContain("shared lesson");
  });

  it("trackAndMaybePromote honors [promote] tag immediately", async () => {
    const entry = { kind: "learning" as const, text: "fast track [promote]" };
    const out = await trackAndMaybePromote("engineer", cfg, "/tmp/p1", [entry]);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const globalRaw = await readFile(join(cfg.globalDir, "engineer.md"), "utf8");
    expect(globalRaw).toContain("fast track");
    expect(globalRaw).not.toContain("[promote]");
  });

  it("readReadonly fails closed on malformed agents frontmatter (round-1 M1)", async () => {
    const ro = join(dirs.projectDir, "_readonly");
    await mkdir(ro, { recursive: true });
    // Missing brackets — malformed list. Without fail-closed, this would
    // incorrectly include the file for ALL agents.
    await writeFile(
      join(ro, "broken.md"),
      `---\nagents: implementer, devops\n---\n# Broken\nbody`,
    );
    const out = await readReadonly("implementer", dirs);
    expect(out).not.toContain("Broken");
  });

  it("readReadonly treats `agents: []` as empty whitelist (round-1 M1)", async () => {
    const ro = join(dirs.projectDir, "_readonly");
    await mkdir(ro, { recursive: true });
    await writeFile(
      join(ro, "off.md"),
      `---\nagents: []\n---\n# Off Limits\nbody`,
    );
    const out = await readReadonly("implementer", dirs);
    expect(out).not.toContain("Off Limits");
  });

  it("caps per-entry text at 500 chars (round-2 M2)", async () => {
    const huge = "x".repeat(10_000);
    const out = await appendExpertise(
      "engineer",
      dirs,
      [{ kind: "learning", text: huge }],
      cfg,
    );
    expect(out).toHaveLength(1);
    expect(out[0].text.length).toBeLessThanOrEqual(500);
    expect(out[0].text.endsWith("…")).toBe(true);
  });

  it("caps batch size to 50 entries (round-2 M2)", async () => {
    const flood = Array.from({ length: 200 }, (_, i) => ({
      kind: "learning" as const,
      text: `entry-${i}`,
    }));
    const out = await appendExpertise("engineer", dirs, flood, cfg);
    expect(out.length).toBeLessThanOrEqual(50);
    // First 50 should win on overflow.
    expect(out[0].text).toBe("entry-0");
  });

  it("readReadonly fails closed on empty agents value (round-2 M1)", async () => {
    const ro = join(dirs.projectDir, "_readonly");
    await mkdir(ro, { recursive: true });
    // Empty value — neither bracket form nor a list. Must NOT default to "all agents".
    await writeFile(
      join(ro, "empty.md"),
      `---\nagents:\nloadOrder: 5\n---\n# Empty Value\nbody`,
    );
    const out = await readReadonly("implementer", dirs);
    expect(out).not.toContain("Empty Value");
  });

  it("expands ~ in cfg.globalDir (round-1 H3)", async () => {
    const tildeCfg: ExpertiseConfig = {
      ...cfg,
      globalDir: "~/__expertise_test_should_not_exist__",
    };
    // resolveDirs must produce an absolute path that doesn't start with "~".
    const { resolveDirs } = await import("../../../src/memory/ExpertiseStore.js");
    const resolved = resolveDirs(tildeCfg, "/tmp/proj");
    expect(resolved.globalDir.startsWith("~")).toBe(false);
    expect(resolved.globalDir.includes("__expertise_test_should_not_exist__")).toBe(true);
  });
});
