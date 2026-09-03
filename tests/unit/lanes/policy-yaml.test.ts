import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { AGENTS } from "../../../src/lanes/catalog.js";
import { BUILTIN_POLICY_PATH } from "../../../src/lanes/load.js";

const JUDGE_UPSERT = [
  "${RUN_DIR}/approvals/",
  "${RUN_DIR}/verdict.md",
  "${RUN_DIR}/dependency-approval.json",
  "${RUN_DIR}/evidence/judge-*.json",
];

describe("built-in policy.yaml", () => {
  it("is schemaVersion 1 with one entry per catalog agent", async () => {
    const raw = parseYaml(await readFile(BUILTIN_POLICY_PATH, "utf8")) as {
      schemaVersion: number;
      agents: Record<string, { upsert?: string[]; delete?: string[]; bash?: string }>;
    };
    expect(raw.schemaVersion).toBe(1);
    expect(Object.keys(raw.agents).sort()).toEqual([...AGENTS].sort());
  });

  it("pins the judge to the four Layer D upsert roots and read-only bash", async () => {
    const raw = parseYaml(await readFile(BUILTIN_POLICY_PATH, "utf8")) as {
      agents: Record<string, { upsert?: string[]; bash?: string }>;
    };
    expect(raw.agents.judge?.upsert).toEqual(JUDGE_UPSERT);
    expect(raw.agents.judge?.bash).toBe("read-only");
  });

  it("sets bash none/read-only/full per spec §7.1", async () => {
    const raw = parseYaml(await readFile(BUILTIN_POLICY_PATH, "utf8")) as {
      agents: Record<string, { bash?: string; upsert?: string[] }>;
    };
    expect(raw.agents["issue-analyst"]?.bash).toBe("none");
    expect(raw.agents.codifier?.bash).toBe("none");
    expect(raw.agents.implementer?.bash).toBe("full");
    expect(raw.agents.tester?.bash).toBe("full");
    expect(raw.agents.planner?.bash).toBe("read-only");
    expect(raw.agents.reviewer?.bash).toBe("read-only");
    expect(raw.agents["security-auditor"]?.bash).toBe("read-only");
    expect(raw.agents.implementer?.upsert).toEqual([]);
  });

  it("gives tester tests/ + ${RUN_DIR}/notes/, planner plan.md, debugger diagnosis.md", async () => {
    const raw = parseYaml(await readFile(BUILTIN_POLICY_PATH, "utf8")) as {
      agents: Record<string, { upsert?: string[] }>;
    };
    expect(raw.agents.tester?.upsert).toEqual(["tests/", "${RUN_DIR}/notes/"]);
    expect(raw.agents.planner?.upsert).toEqual(["${RUN_DIR}/plan.md"]);
    expect(raw.agents.architect?.upsert).toEqual(["${RUN_DIR}/design.md"]);
    expect(raw.agents["root-cause-debugger"]?.upsert).toEqual(["${RUN_DIR}/diagnosis.md"]);
    expect(raw.agents.codifier?.upsert).toEqual(["codified/.staging/", "${RUN_DIR}/codify/"]);
  });
});
