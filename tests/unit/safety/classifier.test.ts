import { describe, it, expect } from "vitest";
import { classifyCommand } from "../../../src/safety/classifier.js";
import { isPlanModeAllowed } from "../../../src/safety/PlanMode.js";
import { SAFE_COMMANDS, DESTRUCTIVE_COMMANDS, BLOCKED_COMMANDS } from "../../helpers/fixtures.js";

describe("classifyCommand — fixture arrays", () => {
  for (const cmd of SAFE_COMMANDS) {
    it(`safe: ${cmd}`, () => {
      expect(classifyCommand(cmd).classification).toBe("safe");
    });
  }

  for (const cmd of DESTRUCTIVE_COMMANDS) {
    it(`destructive: ${cmd}`, () => {
      expect(classifyCommand(cmd).classification).toBe("destructive");
    });
  }

  for (const cmd of BLOCKED_COMMANDS) {
    it(`blocked: ${cmd}`, () => {
      expect(classifyCommand(cmd).classification).toBe("blocked");
    });
  }
});

describe("classifyCommand — compound commands", () => {
  it("cat file.ts | grep foo → safe", () =>
    expect(classifyCommand("cat file.ts | grep foo").classification).toBe("safe"));

  it("cat file.ts | rm -f other → destructive", () =>
    expect(classifyCommand("cat file.ts | rm -f other").classification).toBe("destructive"));

  it("git status && git diff → safe", () =>
    expect(classifyCommand("git status && git diff").classification).toBe("safe"));

  it("git commit -m 'test' → destructive", () =>
    expect(classifyCommand("git commit -m 'test'").classification).toBe("destructive"));
});

describe("classifyCommand — find", () => {
  it("find . -name '*.js' -delete → destructive", () =>
    expect(classifyCommand("find . -name '*.js' -delete").classification).toBe("destructive"));
});

describe("classifyCommand — sed", () => {
  it("sed -i 's/x/y/' file → destructive", () =>
    expect(classifyCommand("sed -i 's/x/y/' file").classification).toBe("destructive"));

  it("sed 's/x/y/' file → safe", () =>
    expect(classifyCommand("sed 's/x/y/' file").classification).toBe("safe"));
});

describe("classifyCommand — awk", () => {
  it("awk '{print}' file → safe", () =>
    expect(classifyCommand("awk '{print}' file").classification).toBe("safe"));

  it("awk -i inplace '{print}' file → destructive", () =>
    expect(classifyCommand("awk -i inplace '{print}' file").classification).toBe("destructive"));
});

describe("classifyCommand — git subcommands", () => {
  it("git log --oneline → safe", () =>
    expect(classifyCommand("git log --oneline").classification).toBe("safe"));

  it("git checkout main → destructive", () =>
    expect(classifyCommand("git checkout main").classification).toBe("destructive"));
});

describe("classifyCommand — npm/pnpm", () => {
  it("npm test → safe", () =>
    expect(classifyCommand("npm test").classification).toBe("safe"));

  it("npm install lodash → destructive", () =>
    expect(classifyCommand("npm install lodash").classification).toBe("destructive"));
});

describe("isPlanModeAllowed", () => {
  it("Read with file_path → allowed", () =>
    expect(isPlanModeAllowed("Read", { file_path: "src/index.ts" })).toBe(true));

  it("Grep with pattern → allowed", () =>
    expect(isPlanModeAllowed("Grep", { pattern: "foo", path: "." })).toBe(true));

  it("Glob with pattern → allowed", () =>
    expect(isPlanModeAllowed("Glob", { pattern: "**/*.ts" })).toBe(true));

  it("Write → blocked", () =>
    expect(isPlanModeAllowed("Write", { file_path: "src/new.ts", content: "..." })).toBe(false));

  it("Edit → blocked", () =>
    expect(isPlanModeAllowed("Edit", { file_path: "src/index.ts" })).toBe(false));

  it("Bash with safe command → allowed", () =>
    expect(isPlanModeAllowed("Bash", { command: "cat README.md" })).toBe(true));

  it("Bash with destructive command → blocked", () =>
    expect(isPlanModeAllowed("Bash", { command: "rm old.txt" })).toBe(false));
});
