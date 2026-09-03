import { describe, expect, it } from "vitest";
import { AGENTS, agentsFor, isAgent } from "../../../src/lanes/catalog.js";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import { CollaborateExecTool, selectTool, v3CodifyDispatch } from "../../../src/v3/collaborate-exec.js";
import { exactDispatchAllowed } from "../../../src/v3/cross-repo.js";
import { maybeLearnerAgent } from "../../../src/v3/learner.js";

describe("v3 flags-off default dispatch", () => {
  it("does not select collaborate-exec, cross-repo exact, or learner", () => {
    const cfg = { v3: DEFAULT_V3_POLICY };
    const tool = new CollaborateExecTool({ id: "plan-dag-exec", state: "active" });
    expect(selectTool("implement", cfg, [tool])).toBeNull();
    expect(exactDispatchAllowed(cfg, "acme/app", "plan-dag-exec@1", { shadowAgree: 9 })).toBe(false);
    expect(v3CodifyDispatch(cfg, tool, { shadowAgree: 9, source: "local" }).exact).toBe(false);
    expect(maybeLearnerAgent(cfg, [])).toBeNull();
    expect(agentsFor(cfg, [])).toEqual([...AGENTS]);
    expect(agentsFor(cfg, [])).toHaveLength(13);
    expect(isAgent("learner")).toBe(false);
    expect(AGENTS).not.toContain("learner");
  });
});
