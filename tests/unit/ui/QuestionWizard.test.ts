import { describe, it, expect, vi } from "vitest";
import { QuestionWizard } from "../../../src/ui/QuestionWizard.js";
import type { QuestionCategory } from "../../../src/commands/spec-utils.js";

function makeMockTui() {
  return { requestRender: vi.fn() } as any;
}

function makeMockTheme() {
  return { fg: (_color: string, text: string) => text } as any;
}

const CATEGORIES: QuestionCategory[] = [
  { name: "SCOPE", questions: ["Who are the users?", "What are the boundaries?"] },
  { name: "SUCCESS", questions: ["What does done look like?"] },
];

describe("QuestionWizard", () => {
  it("render() includes category tab names", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    const lines = wizard.render(80);
    const output = lines.join("\n");
    expect(output).toContain("SCOPE");
    expect(output).toContain("SUCCESS");
  });

  it("render() shows first category questions by default", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    const output = wizard.render(80).join("\n");
    expect(output).toContain("Who are the users?");
    expect(output).toContain("What are the boundaries?");
    expect(output).not.toContain("What does done look like?");
  });

  it("right arrow key switches to next tab", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    wizard.handleInput("\x1b[C"); // right arrow
    const output = wizard.render(80).join("\n");
    expect(output).toContain("What does done look like?");
    expect(output).not.toContain("Who are the users?");
  });

  it("left arrow does not go below tab 0", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    wizard.handleInput("\x1b[D"); // left arrow
    const output = wizard.render(80).join("\n");
    expect(output).toContain("Who are the users?"); // still on SCOPE
  });

  it("Ctrl+Enter with all fields empty does not call done", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    wizard.handleInput("\x1b[13;5u"); // Ctrl+Enter (Kitty)
    expect(done).not.toHaveBeenCalled();
  });

  it("invalidate() does not throw", () => {
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, vi.fn());
    expect(() => wizard.invalidate()).not.toThrow();
  });
});
