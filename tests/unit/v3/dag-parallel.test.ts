import { describe, it, expect } from "vitest";
import type { Workspace } from "../../../src/workspace/types.js";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import { validatePlanDag, scheduleDag, runDagParallel, PlanDagError, type DagTask } from "../../../src/v3/dag-parallel.js";

function fakeWs(over: Partial<Workspace> = {}): Workspace {
  return {
    provider: "git",
    path: "/tmp/ws-primary",
    branch: "factory/local-1",
    baseSha: "a".repeat(40),
    repoRoot: "/tmp/repo",
    gitCommonDir: "/tmp/repo/.git",
    configSha: "c".repeat(64),
    ...over,
  };
}

const a: DagTask = { id: "a", dependsOn: [], files: ["src/a.ts"] };
const b: DagTask = { id: "b", dependsOn: [], files: ["src/b.ts"] };

describe("validatePlanDag", () => {
  it("rejects a cycle", () => {
    expect(() =>
      validatePlanDag(
        {
          tasks: [
            { id: "a", dependsOn: ["b"], files: ["src/a.ts"] },
            { id: "b", dependsOn: ["a"], files: ["src/b.ts"] },
          ],
        },
        ["src/**"],
      ),
    ).toThrow(PlanDagError);
    try {
      validatePlanDag(
        {
          tasks: [
            { id: "a", dependsOn: ["b"], files: ["src/a.ts"] },
            { id: "b", dependsOn: ["a"], files: ["src/b.ts"] },
          ],
        },
        ["src/**"],
      );
    } catch (e) {
      expect(e).toBeInstanceOf(PlanDagError);
      expect((e as PlanDagError).code).toBe("cycle");
    }
  });

  it("rejects files outside writeRoots", () => {
    expect(() =>
      validatePlanDag({ tasks: [{ id: "a", dependsOn: [], files: ["docs/secret.md"] }] }, ["src/**"]),
    ).toThrow(/writeRoots|write-roots/i);
  });

  it("accepts file-disjoint acyclic tasks inside writeRoots", () => {
    expect(() => validatePlanDag({ tasks: [a, b] }, ["src/**"])).not.toThrow();
  });
});

describe("scheduleDag", () => {
  it("puts file-disjoint independent tasks in the same wave", () => {
    expect(scheduleDag([a, b])).toEqual([["a", "b"]]);
  });

  it("schedules a dependency after its parent even when files are disjoint", () => {
    const dependent: DagTask = { id: "b", dependsOn: ["a"], files: ["src/b.ts"] };
    expect(scheduleDag([a, dependent])).toEqual([["a"], ["b"]]);
  });

  it("splits overlapping files into later waves", () => {
    const c: DagTask = { id: "c", dependsOn: [], files: ["src/a.ts"] };
    expect(scheduleDag([a, c])).toEqual([["a"], ["c"]]);
  });
});

describe("runDagParallel", () => {
  it("runs sequentially on the primary and does not create siblings when the flag is off", async () => {
    const primary = fakeWs();
    const order: string[] = [];
    const siblingCalls: Array<{ n: number; suffix: string }> = [];
    const result = await runDagParallel({
      cfg: { v3: DEFAULT_V3_POLICY },
      primary,
      tasks: [a, { id: "b", dependsOn: ["a"], files: ["src/b.ts"] }],
      runTask: async (ws, task) => {
        order.push(`${ws.path}:${task.id}`);
        return { files: { [task.files[0]!]: task.id } };
      },
      createSiblings: async (_ws, n, suffix) => {
        siblingCalls.push({ n, suffix });
        return [fakeWs({ path: `/tmp/sib-${suffix}` })];
      },
    });
    expect(order).toEqual([`${primary.path}:a`, `${primary.path}:b`]);
    expect(siblingCalls).toEqual([]);
    expect(result.parallel).toBe(false);
    expect(result.order).toEqual(["a", "b"]);
  });

  it("creates one sibling worktree per independent task when the flag is on", async () => {
    const primary = fakeWs();
    const siblingCalls: Array<{ n: number; suffix: string }> = [];
    const paths: Record<string, string> = {};
    const applied: string[] = [];
    const result = await runDagParallel({
      cfg: { v3: { dagParallel: { enabled: true } } },
      primary,
      tasks: [a, b],
      runTask: async (ws, task) => {
        paths[task.id] = ws.path;
        return { files: { [task.files[0]!]: `${task.id}-body` } };
      },
      createSiblings: async (_ws, n, suffix) => {
        siblingCalls.push({ n, suffix });
        return [fakeWs({ path: `/tmp/sib-${suffix}`, branch: `factory/local-1-${suffix}` })];
      },
      applyFiles: async (ws, files) => {
        expect(ws.path).toBe(primary.path);
        applied.push(...Object.keys(files));
      },
    });
    expect(siblingCalls).toHaveLength(2);
    expect(siblingCalls.map((c) => c.n)).toEqual([1, 1]);
    expect(paths.a).not.toBe(primary.path);
    expect(paths.b).not.toBe(primary.path);
    expect(paths.a).not.toBe(paths.b);
    expect(result.parallel).toBe(true);
    expect(result.waves[0]?.slice().sort()).toEqual(["a", "b"]);
    expect(applied.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("waits on overlapping files even when the flag is on", async () => {
    const primary = fakeWs();
    const order: string[] = [];
    const result = await runDagParallel({
      cfg: { v3: { dagParallel: { enabled: true } } },
      primary,
      tasks: [a, { id: "c", dependsOn: [], files: ["src/a.ts"] }],
      runTask: async (_ws, task) => {
        order.push(task.id);
        return { files: { "src/a.ts": task.id } };
      },
      createSiblings: async (_ws, _n, suffix) => [fakeWs({ path: `/tmp/sib-${suffix}` })],
      applyFiles: async () => {},
    });
    expect(result.waves).toEqual([["a"], ["c"]]);
    expect(order).toEqual(["a", "c"]);
  });
});
