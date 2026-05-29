import { describe, it, expect } from "vitest";
import { classifyCommand } from "../../../src/safety/classifier.js";
import { isPlanModeAllowed } from "../../../src/safety/PlanMode.js";
import { bashLayerAGuard } from "../../../src/safety/SafetyGuard.js";
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

describe("classifyCommand — xargs (wraps inner verb)", () => {
  it("find . -name '*.java' | xargs grep foo | head -50 → safe", () =>
    expect(
      classifyCommand("find . -name '*.java' | xargs grep foo | head -50").classification,
    ).toBe("safe"));

  it("find . | xargs -0 grep foo → safe (xargs flag skipped)", () =>
    expect(classifyCommand("find . | xargs -0 grep foo").classification).toBe("safe"));

  it("find . | xargs -I {} cat {} → safe (xargs -I {} skipped)", () =>
    expect(classifyCommand("find . | xargs -I {} cat {}").classification).toBe("safe"));

  it("find . | xargs rm -f → destructive (wrapped verb destructive)", () =>
    expect(classifyCommand("find . | xargs rm -f").classification).toBe("destructive"));

  it("find / -name x | xargs rm -rf → blocked (dangerous-rm pattern wins)", () =>
    expect(classifyCommand("find / -name x | xargs rm -rf /").classification).toBe("blocked"));

  it("xargs (bare) → safe", () =>
    expect(classifyCommand("xargs").classification).toBe("safe"));
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

describe("bashLayerAGuard — _controller Bash rule (CRITICAL self-forge fix)", () => {
  it("blocks: cat /x/runs/_controller/.secret", () => {
    const result = bashLayerAGuard("cat /x/runs/_controller/.secret");
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.layer).toBe("A");
    expect(result!.reason).toMatch(/_controller/);
  });

  it("blocks: echo y > /x/runs/_controller/approvals/t.json", () => {
    const result = bashLayerAGuard("echo y > /x/runs/_controller/approvals/t.json");
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.layer).toBe("A");
  });

  it("blocks: cat z > runs/_controller/approvals/a.json", () => {
    const result = bashLayerAGuard("cat z > runs/_controller/approvals/a.json");
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.layer).toBe("A");
  });

  it("blocks quote-concat bypass: cat runs/_cont\"roller\"/.secret", () => {
    // After dequoting: cat runs/_controller/.secret
    const result = bashLayerAGuard('cat runs/_cont"roller"/.secret');
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.layer).toBe("A");
  });

  it("does NOT block a benign command not referencing _controller", () => {
    const result = bashLayerAGuard("ls runs/");
    // Should return undefined (not blocked by this rule); other rules may or may not match
    // The _controller rule specifically must not trigger
    if (result) {
      expect(result.reason).not.toMatch(/_controller/);
    }
  });
});

describe("classifyCommand — write redirects", () => {
  // DESTRUCTIVE: safe verb + write redirect to a real file
  it("cat x > /etc/foo → destructive", () =>
    expect(classifyCommand("cat x > /etc/foo").classification).toBe("destructive"));

  it("jq . a > out.json → destructive", () =>
    expect(classifyCommand("jq . a > out.json").classification).toBe("destructive"));

  it("echo hi >> log.txt → destructive", () =>
    expect(classifyCommand("echo hi >> log.txt").classification).toBe("destructive"));

  it("sort f > sorted.txt → destructive", () =>
    expect(classifyCommand("sort f > sorted.txt").classification).toBe("destructive"));

  it("cat a > b → destructive", () =>
    expect(classifyCommand("cat a > b").classification).toBe("destructive"));

  it("date > stamp → destructive", () =>
    expect(classifyCommand("date > stamp").classification).toBe("destructive"));

  it("grep x log > matches.txt → destructive", () =>
    expect(classifyCommand("grep x log > matches.txt").classification).toBe("destructive"));

  it("tr a b < in > out → destructive (has write redirect)", () =>
    expect(classifyCommand("tr a b < in > out").classification).toBe("destructive"));

  it("cmd 2> err.log → destructive (stderr to file)", () =>
    expect(classifyCommand("cmd 2> err.log").classification).toBe("destructive"));

  it("cat x >| f → destructive (clobber redirect)", () =>
    expect(classifyCommand("cat x >| f").classification).toBe("destructive"));

  it("cat secret >| /etc/foo → destructive (clobber redirect)", () =>
    expect(classifyCommand("cat secret >| /etc/foo").classification).toBe("destructive"));

  it("cat secret >| cat → destructive (clobber target that is itself a safe verb)", () =>
    expect(classifyCommand("cat secret >| cat").classification).toBe("destructive"));

  // SAFE: no redirect, or harmless redirect targets, or input-redirect only
  it("cat file (no redirect) → safe", () =>
    expect(classifyCommand("cat file").classification).toBe("safe"));

  it("cat file > /dev/null → safe (harmless target excluded)", () =>
    expect(classifyCommand("cat file > /dev/null").classification).toBe("safe"));

  it("cat file > /dev/null 2>&1 → safe (harmless target + fd dup)", () =>
    expect(classifyCommand("cat file > /dev/null 2>&1").classification).toBe("safe"));

  it("grep x file 2>&1 (fd dup only, no file target) → safe", () =>
    expect(classifyCommand("grep x file 2>&1").classification).toBe("safe"));

  it("cat x >| /dev/null → safe (clobber to harmless target)", () =>
    expect(classifyCommand("cat x >| /dev/null").classification).toBe("safe"));

  it("grep x file (no redirect) → safe", () =>
    expect(classifyCommand("grep x file").classification).toBe("safe"));

  it("sort f < input (input redirect only) → safe", () =>
    expect(classifyCommand("sort f < input").classification).toBe("safe"));

  it("ls -la (no redirect) → safe", () =>
    expect(classifyCommand("ls -la").classification).toBe("safe"));

  // Destructive verb unaffected
  it("rm x → destructive (verb, not redirect rule)", () =>
    expect(classifyCommand("rm x").classification).toBe("destructive"));
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
