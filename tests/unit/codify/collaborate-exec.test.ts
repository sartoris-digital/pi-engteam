import { describe, expect, it } from "vitest";
import { DEFAULT_V3_POLICY, type V3Policy } from "../../../src/v3/dispatch.js";
import {
  COLLABORATE_EXEC_CLASS,
  CollaborateExecTool,
  selectTool,
} from "../../../src/v3/collaborate-exec.js";
import type { WorkerExecutor, WorkerRequest, WorkerResult } from "../../../src/runtime/types.js";

function cfg(over: Partial<{ [K in keyof V3Policy]: Partial<V3Policy[K]> }> = {}): { v3: V3Policy } {
  const v3 = structuredClone(DEFAULT_V3_POLICY);
  for (const [key, value] of Object.entries(over) as Array<[keyof V3Policy, Partial<V3Policy[keyof V3Policy]>]>) {
    Object.assign(v3[key], value);
  }
  return { v3 };
}

const active = new CollaborateExecTool({
  id: "plan-dag-exec",
  state: "active",
  stages: ["implement"],
});
const probationary = new CollaborateExecTool({
  id: "plan-dag-exec",
  state: "probationary",
  stages: ["implement"],
});

describe("selectTool", () => {
  it("returns null when the flag is off even if the tool is active", () => {
    expect(selectTool("implement", cfg(), [active])).toBeNull();
    expect(selectTool("implement", cfg({ collaborateExecution: { enabled: false } }), [active])).toBeNull();
  });

  it("returns null for a probationary tool when the flag is on", () => {
    expect(selectTool("implement", cfg({ collaborateExecution: { enabled: true } }), [probationary])).toBeNull();
  });

  it("returns the active collaborate-exec tool id when the flag is on", () => {
    const selected = selectTool("implement", cfg({ collaborateExecution: { enabled: true } }), [active]);
    expect(selected?.id).toBe("plan-dag-exec");
    expect(selected?.class).toBe(COLLABORATE_EXEC_CLASS);
  });
});

describe("CollaborateExecTool.run", () => {
  it("applies a reviewed patch plan without invoking WorkerExecutor", async () => {
    let executorCalls = 0;
    const executor: WorkerExecutor = {
      async run(_req: WorkerRequest): Promise<WorkerResult> {
        executorCalls += 1;
        throw new Error("WorkerExecutor must not run for collaborate-exec");
      },
    };
    const tool = new CollaborateExecTool({ id: "plan-dag-exec", state: "active" });
    const result = await tool.run({
      plan: {
        tasks: [
          { id: "a", dependsOn: [], files: ["src/a.ts"], patch: { "src/a.ts": "export const a = 1;\n" } },
          { id: "b", dependsOn: ["a"], files: ["src/b.ts"], patch: { "src/b.ts": "export const b = 2;\n" } },
        ],
      },
      executor,
    });
    expect(executorCalls).toBe(0);
    expect(result.files).toEqual({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    expect(result.usedExecutor).toBe(false);
  });
});
