// tests/unit/commands/issue-tracker.test.ts
import { describe, it, expect } from "vitest";
import { parseUrl, detectTracker } from "../../../src/commands/issue-tracker.js";

describe("parseUrl", () => {
  it("detects GitHub URL", () => {
    expect(parseUrl("https://github.com/org/repo/issues/42"))
      .toEqual({ tracker: "github", ticketId: "42" });
  });

  it("detects Azure DevOps URL", () => {
    expect(parseUrl("https://dev.azure.com/myorg/myproject/_workitems/edit/99"))
      .toEqual({ tracker: "ado", ticketId: "99" });
  });

  it("detects Jira URL", () => {
    expect(parseUrl("https://company.atlassian.net/browse/PROJ-123"))
      .toEqual({ tracker: "jira", ticketId: "PROJ-123" });
  });

  it("returns null for non-tracker URL", () => {
    expect(parseUrl("https://example.com/page")).toBeNull();
  });

  it("returns null for plain string", () => {
    expect(parseUrl("just text")).toBeNull();
  });
});

describe("detectTracker", () => {
  it("detects GitHub from URL", async () => {
    const result = await detectTracker("https://github.com/org/repo/issues/42");
    expect(result).toEqual({ tracker: "github", ticketId: "42" });
  });

  it("uses explicit ado flag for bare number", async () => {
    expect(await detectTracker("99", "ado")).toEqual({ tracker: "ado", ticketId: "99" });
  });

  it("uses explicit github flag, strips # prefix", async () => {
    expect(await detectTracker("#42", "github")).toEqual({ tracker: "github", ticketId: "42" });
  });

  it("uses explicit jira flag", async () => {
    expect(await detectTracker("PROJ-123", "jira")).toEqual({ tracker: "jira", ticketId: "PROJ-123" });
  });

  it("URL takes precedence over --tracker flag", async () => {
    const result = await detectTracker("https://github.com/org/repo/issues/5", "jira");
    expect(result).toEqual({ tracker: "github", ticketId: "5" });
  });

  it("detects Jira bare ID pattern", async () => {
    const result = await detectTracker("PROJ-123");
    expect(result).toEqual({ tracker: "jira", ticketId: "PROJ-123" });
  });

  it("detects multi-char Jira project key", async () => {
    const result = await detectTracker("MYPROJECT-456");
    expect(result).toEqual({ tracker: "jira", ticketId: "MYPROJECT-456" });
  });
});
