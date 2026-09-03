import { describe, it, expect } from "vitest";
import { GhError, ensureRepoFlag, realGhExec } from "../../../src/trackers/gh.js";

describe("gh exec port", () => {
  it("GhError exposes code and stderr", () => {
    const err = new GhError("auth failed", 1, "not logged in");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GhError");
    expect(err.code).toBe(1);
    expect(err.stderr).toBe("not logged in");
  });

  it("ensureRepoFlag appends --repo when missing and leaves an existing flag alone", () => {
    expect(ensureRepoFlag(["issue", "list"], "acme/widgets")).toEqual([
      "issue",
      "list",
      "--repo",
      "acme/widgets",
    ]);
    expect(ensureRepoFlag(["issue", "list", "--repo", "other/repo"], "acme/widgets")).toEqual([
      "issue",
      "list",
      "--repo",
      "other/repo",
    ]);
  });

  it("realGhExec returns a function and is not invoked in unit tests", () => {
    expect(typeof realGhExec()).toBe("function");
  });
});
