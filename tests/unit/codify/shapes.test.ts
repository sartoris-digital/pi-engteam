import { describe, expect, it } from "vitest";
import {
  detectMechanicalShape,
  FEATURE_WEIGHTS,
  featuresOf,
  MECHANICAL_SHAPES,
  scoreFeatures,
} from "../../../src/codify/shapes.js";
import { featureDiffExecution, versionBumpExecution } from "../../helpers/codify-cluster.js";

describe("FEATURE_WEIGHTS", () => {
  it("sums to 1", () => {
    const sum = Object.values(FEATURE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(FEATURE_WEIGHTS).toEqual({
      reproducibleByCommand: 0.35,
      diffIsSubstitution: 0.2,
      literalsSourced: 0.15,
      zeroFixRounds: 0.1,
      lowModelEffort: 0.1,
      planImperative: 0.05,
      small: 0.05,
    });
  });
});

describe("MECHANICAL_SHAPES", () => {
  it("is the frozen catalogue", () => {
    expect(MECHANICAL_SHAPES).toEqual([
      "version-bump",
      "dependency-companion",
      "changelog-entry",
      "codegen-docs",
      "boilerplate-from-sibling",
      "migration-scaffold",
      "rename",
      "config-toggle",
      "header-insertion",
      "formatting-only",
    ]);
  });
});

describe("scoreFeatures / detectMechanicalShape", () => {
  it("scores a sourced package.json + lockfile version bump ≥ 0.7 as version-bump", () => {
    const ex = versionBumpExecution();
    const score = scoreFeatures(featuresOf(ex));
    expect(score).toBeGreaterThanOrEqual(0.7);
    expect(detectMechanicalShape(ex)).toBe("version-bump");
  });

  it("scores a 200-line 12-file feature diff < 0.5 with no shape", () => {
    const ex = featureDiffExecution();
    expect(scoreFeatures(featuresOf(ex))).toBeLessThan(0.5);
    expect(detectMechanicalShape(ex)).toBeNull();
  });

  it("clamps the weighted sum to [0, 1]", () => {
    expect(scoreFeatures({
      reproducibleByCommand: 2,
      diffIsSubstitution: 2,
      literalsSourced: 2,
      zeroFixRounds: 2,
      lowModelEffort: 2,
      planImperative: 2,
      small: 2,
    })).toBe(1);
    expect(scoreFeatures({
      reproducibleByCommand: -1,
      diffIsSubstitution: -1,
      literalsSourced: -1,
      zeroFixRounds: -1,
      lowModelEffort: -1,
      planImperative: -1,
      small: -1,
    })).toBe(0);
  });
});
