import { describe, expect, it } from "vitest";
import { DEFAULT_V3_POLICY, type V3Policy } from "../../../src/v3/dispatch.js";
import { COLLABORATE_EXEC_CLASS, CollaborateExecTool, selectTool } from "../../../src/v3/collaborate-exec.js";
import { exactDispatchAllowed } from "../../../src/v3/cross-repo.js";
import { v3CodifyDispatch } from "../../../src/v3/collaborate-exec.js";

function cfg(over: {
  collaborateExecution?: boolean;
  crossRepoTools?: boolean;
  dispatch?: "off" | "shadow" | "partial" | "exact";
  shadowAgreeToActivate?: number;
}): { v3: V3Policy; codify: { dispatch: "off" | "shadow" | "partial" | "exact"; shadowAgreeToActivate: number } } {
  const v3 = structuredClone(DEFAULT_V3_POLICY);
  if (over.collaborateExecution !== undefined) v3.collaborateExecution.enabled = over.collaborateExecution;
  if (over.crossRepoTools !== undefined) v3.crossRepoTools.enabled = over.crossRepoTools;
  return {
    v3,
    codify: {
      dispatch: over.dispatch ?? "exact",
      shadowAgreeToActivate: over.shadowAgreeToActivate ?? 2,
    },
  };
}

describe("v3CodifyDispatch", () => {
  it("refuses exact substitute when collaborateExecution is on but codify.dispatch is off", () => {
    const tool = new CollaborateExecTool({ id: "plan-dag-exec", state: "active" });
    const result = v3CodifyDispatch(cfg({ collaborateExecution: true, dispatch: "off" }), tool, {
      shadowAgree: 9,
      source: "local",
    });
    expect(result.exact).toBe(false);
    expect(result.reason).toMatch(/codify-dispatch-off|off/);
    expect(selectTool("implement", cfg({ collaborateExecution: true, dispatch: "off" }), [tool])).not.toBeNull();
  });

  it("refuses exact when crossRepoTools is on but the target repo shadow count is 0", () => {
    const result = v3CodifyDispatch(
      cfg({ crossRepoTools: true, dispatch: "exact" }),
      { class: COLLABORATE_EXEC_CLASS, state: "probationary", id: "shared-tool", source: "shared" },
      { shadowAgree: 0, source: "shared" },
    );
    expect(result.exact).toBe(false);
    expect(result.reason).toMatch(/shadow/);
    expect(exactDispatchAllowed(cfg({ crossRepoTools: true }), "acme/target", "shared-tool@1", { shadowAgree: 0 })).toBe(
      false,
    );
  });

  it("does not change v1.5 routing when both v3 flags are off", () => {
    const tool = new CollaborateExecTool({ id: "plan-dag-exec", state: "active" });
    const local = v3CodifyDispatch(cfg({ dispatch: "exact" }), tool, { shadowAgree: 9, source: "local" });
    expect(local.exact).toBe(false);
    expect(local.reason).toMatch(/flag-off|v1\.5/);
    expect(selectTool("implement", cfg({}), [tool])).toBeNull();
    expect(exactDispatchAllowed(cfg({}), "acme/target", "bump-pkg@1", { shadowAgree: 9 })).toBe(false);

    const shared = v3CodifyDispatch(
      cfg({ dispatch: "exact" }),
      { class: "stage-tool", state: "active", id: "bump-pkg", source: "shared" },
      { shadowAgree: 9, source: "shared" },
    );
    expect(shared.exact).toBe(false);
  });
});
