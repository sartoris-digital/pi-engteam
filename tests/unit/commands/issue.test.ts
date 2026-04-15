// tests/unit/commands/issue.test.ts
import { describe, it, expect } from "vitest";
import { parseIssueArgs, parseBrief } from "../../../src/commands/issue.js";

describe("parseIssueArgs", () => {
  it("parses bare ticket ref with no flag", () => {
    expect(parseIssueArgs("42")).toEqual({ ticketRef: "42", trackerFlag: undefined });
  });

  it("parses a full URL with no flag", () => {
    expect(parseIssueArgs("https://github.com/org/repo/issues/42")).toEqual({
      ticketRef: "https://github.com/org/repo/issues/42",
      trackerFlag: undefined,
    });
  });

  it("parses --tracker flag after ref", () => {
    expect(parseIssueArgs("99 --tracker ado")).toEqual({ ticketRef: "99", trackerFlag: "ado" });
  });

  it("parses --tracker flag before ref", () => {
    expect(parseIssueArgs("--tracker jira PROJ-123")).toEqual({
      ticketRef: "PROJ-123",
      trackerFlag: "jira",
    });
  });

  it("returns empty ticketRef for empty string", () => {
    expect(parseIssueArgs("")).toEqual({ ticketRef: "", trackerFlag: undefined });
  });
});

describe("parseBrief", () => {
  const SAMPLE_BRIEF = `# Issue Brief: Add dark mode

## Source
Tracker: github
ID: 42

## Problem / Request
Users want dark mode.

## Acceptance Criteria
- Dark mode toggle in settings

## Context
label: enhancement

## Suggested Workflow
spec-plan-build-review

## Goal
Add a dark mode toggle to the settings screen
`;

  it("parses suggested workflow and goal", () => {
    expect(parseBrief(SAMPLE_BRIEF)).toEqual({
      suggestedWorkflow: "spec-plan-build-review",
      goal: "Add a dark mode toggle to the settings screen",
    });
  });

  it("works for fix-loop workflow type", () => {
    const brief = `## Suggested Workflow\nfix-loop\n\n## Goal\nFix the null pointer in auth middleware\n`;
    expect(parseBrief(brief)).toEqual({
      suggestedWorkflow: "fix-loop",
      goal: "Fix the null pointer in auth middleware",
    });
  });

  it("returns null when Suggested Workflow section is missing", () => {
    expect(parseBrief("# Issue Brief\n\n## Goal\nSomething")).toBeNull();
  });

  it("returns null when Goal section is missing", () => {
    expect(parseBrief("## Suggested Workflow\ndebug")).toBeNull();
  });
});
