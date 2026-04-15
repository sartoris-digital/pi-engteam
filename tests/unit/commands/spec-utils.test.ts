import { describe, it, expect } from "vitest";
import { parseQuestionsFile, formatAnswers } from "../../../src/commands/spec-utils.js";

const SAMPLE_QUESTIONS = `## SCOPE
1. Who are the primary users and what task are they trying to complete?
2. What are the hard boundaries — what will this explicitly not do?

## CONSTRAINTS
3. Are there technology, platform, or timeline constraints to work within?

## SUCCESS
4. What does a successful outcome look like?
`;

describe("parseQuestionsFile", () => {
  it("parses categories and questions from markdown", () => {
    const result = parseQuestionsFile(SAMPLE_QUESTIONS);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("SCOPE");
    expect(result[0].questions).toHaveLength(2);
    expect(result[0].questions[0]).toBe("Who are the primary users and what task are they trying to complete?");
    expect(result[1].name).toBe("CONSTRAINTS");
    expect(result[1].questions).toHaveLength(1);
    expect(result[2].name).toBe("SUCCESS");
  });

  it("returns empty array for empty input", () => {
    expect(parseQuestionsFile("")).toEqual([]);
  });

  it("ignores lines that are not headings or numbered questions", () => {
    const result = parseQuestionsFile("Some preamble\n## SCOPE\n1. A question\nsome prose");
    expect(result[0].questions).toHaveLength(1);
  });
});

describe("formatAnswers", () => {
  it("produces markdown with category headings and Q&A pairs", () => {
    const categories = [
      { name: "SCOPE", questions: ["Who are the users?"] },
      { name: "SUCCESS", questions: ["What is done?"] },
    ];
    const answers = { SCOPE: ["Developers"], SUCCESS: ["Tests pass"] };
    const result = formatAnswers(answers, categories);
    expect(result).toContain("## SCOPE");
    expect(result).toContain("Who are the users?");
    expect(result).toContain("Developers");
    expect(result).toContain("## SUCCESS");
    expect(result).toContain("Tests pass");
  });

  it("uses placeholder when an answer is missing", () => {
    const categories = [{ name: "SCOPE", questions: ["Question one?"] }];
    const result = formatAnswers({}, categories);
    expect(result).toContain("(no answer)");
  });
});
