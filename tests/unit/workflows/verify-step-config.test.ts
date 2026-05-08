import { describe, it, expect } from "vitest";
import { planBuildReview } from "../../../src/workflows/plan-build-review.js";
import { planBuildReviewFix } from "../../../src/workflows/plan-build-review-fix.js";
import { migration } from "../../../src/workflows/migration.js";
import { fixLoop } from "../../../src/workflows/fix-loop.js";
import { refactorCampaign } from "../../../src/workflows/refactor-campaign.js";
import type { Workflow } from "../../../src/workflows/types.js";

function findStep(wf: Workflow, name: string) {
  const step = wf.steps.find((s) => s.name === name);
  if (!step) throw new Error(`step ${name} missing from ${wf.name}`);
  return step;
}

describe("verify-step-config", () => {
  it("plan-build-review: only build has verify=true with implementer agent", () => {
    expect(findStep(planBuildReview, "build").verify).toBe(true);
    expect(findStep(planBuildReview, "build").agent).toBe("implementer");
    expect(findStep(planBuildReview, "plan").verify).toBeFalsy();
    expect(findStep(planBuildReview, "review").verify).toBeFalsy();
  });

  it("plan-build-review-fix: build and fix both have verify=true", () => {
    expect(findStep(planBuildReviewFix, "build").verify).toBe(true);
    expect(findStep(planBuildReviewFix, "fix").verify).toBe(true);
    expect(findStep(planBuildReviewFix, "build").agent).toBe("implementer");
    expect(findStep(planBuildReviewFix, "fix").agent).toBe("implementer");
    expect(findStep(planBuildReviewFix, "plan").verify).toBeFalsy();
    expect(findStep(planBuildReviewFix, "review").verify).toBeFalsy();
  });

  it("migration: implement has verify=true", () => {
    expect(findStep(migration, "implement").verify).toBe(true);
    expect(findStep(migration, "implement").agent).toBe("implementer");
    expect(findStep(migration, "plan").verify).toBeFalsy();
    expect(findStep(migration, "test").verify).toBeFalsy();
  });

  it("fix-loop: implement has verify=true; analyze does not", () => {
    expect(findStep(fixLoop, "implement").verify).toBe(true);
    expect(findStep(fixLoop, "implement").agent).toBe("implementer");
    expect(findStep(fixLoop, "analyze").verify).toBeFalsy();
    expect(findStep(fixLoop, "review").verify).toBeFalsy();
  });

  it("refactor-campaign: implement has verify=true", () => {
    expect(findStep(refactorCampaign, "implement").verify).toBe(true);
    expect(findStep(refactorCampaign, "implement").agent).toBe("implementer");
    expect(findStep(refactorCampaign, "design").verify).toBeFalsy();
  });
});
