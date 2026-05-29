import { describe, it, expect } from "vitest";
import { specPlanBuildReview } from "../../../src/workflows/spec-plan-build-review.js";

describe("specPlanBuildReview workflow", () => {
  it("has the correct step order", () => {
    const names = specPlanBuildReview.steps.map(s => s.name);
    expect(names).toEqual(["discover", "design", "plan", "build", "review"]);
  });

  it("no step pauses for the user — pauseAfter flags removed for autonomous GHCP runs (a4247c3)", () => {
    const discover = specPlanBuildReview.steps.find(s => s.name === "discover")!;
    const design   = specPlanBuildReview.steps.find(s => s.name === "design")!;
    const plan     = specPlanBuildReview.steps.find(s => s.name === "plan")!;
    const build    = specPlanBuildReview.steps.find(s => s.name === "build")!;
    const review   = specPlanBuildReview.steps.find(s => s.name === "review")!;

    expect(discover.planMode).toBe(false);
    expect(discover.pauseAfter).toBeUndefined();
    expect(design.pauseAfter).toBeUndefined();
    expect(plan.pauseAfter).toBeUndefined();
    expect(build.pauseAfter).toBeUndefined();
    expect(review.pauseAfter).toBeUndefined();
  });

  it("transitions PASS correctly: discover→design→plan→build→review→halt", () => {
    const passResult = { success: true, verdict: "PASS" as const };
    const failResult = { success: false, verdict: "FAIL" as const };

    function findTransition(from: string, r: typeof passResult) {
      return specPlanBuildReview.transitions.find(t => t.from === from && t.when(r))?.to;
    }

    expect(findTransition("discover", passResult)).toBe("design");
    expect(findTransition("discover", failResult)).toBe("design");
    expect(findTransition("design",   passResult)).toBe("plan");
    expect(findTransition("plan",     passResult)).toBe("build");
    expect(findTransition("build",    passResult)).toBe("review");
    expect(findTransition("build",    failResult)).toBe("plan");
    expect(findTransition("review",   passResult)).toBe("halt");
  });
});
