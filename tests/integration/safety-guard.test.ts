import { describe, it, expect } from "vitest";
import { classifyCommand } from "../../src/safety/classifier.js";

describe("classifier integration", () => {
  // Blocked: hard-stop patterns
  it("blocks rm -rf /", () => {
    const result = classifyCommand("rm -rf /");
    expect(result.classification).toBe("blocked");
  });

  it("blocks rm -rf ~", () => {
    const result = classifyCommand("rm -rf ~");
    expect(result.classification).toBe("blocked");
  });

  it("blocks git push --force", () => {
    const result = classifyCommand("git push --force");
    expect(result.classification).toBe("blocked");
  });

  it("blocks git push -f origin main", () => {
    const result = classifyCommand("git push -f origin main");
    expect(result.classification).toBe("blocked");
  });

  it("blocks sudo commands", () => {
    const result = classifyCommand("sudo rm -rf /tmp/foo");
    expect(result.classification).toBe("blocked");
  });

  it("blocks npm publish", () => {
    const result = classifyCommand("npm publish");
    expect(result.classification).toBe("blocked");
  });

  // Safe: read-only operations
  it("allows git status", () => {
    const result = classifyCommand("git status");
    expect(result.classification).toBe("safe");
  });

  it("allows git diff", () => {
    const result = classifyCommand("git diff HEAD~1");
    expect(result.classification).toBe("safe");
  });

  it("allows git log", () => {
    const result = classifyCommand("git log --oneline -10");
    expect(result.classification).toBe("safe");
  });

  it("allows pnpm test", () => {
    const result = classifyCommand("pnpm test");
    expect(result.classification).toBe("safe");
  });

  it("allows vitest run", () => {
    const result = classifyCommand("vitest run");
    expect(result.classification).toBe("safe");
  });

  it("allows cat", () => {
    const result = classifyCommand("cat src/index.ts");
    expect(result.classification).toBe("safe");
  });

  it("allows grep", () => {
    const result = classifyCommand("grep -r 'export' src/");
    expect(result.classification).toBe("safe");
  });

  // Destructive: requires approval but not blocked
  it("marks git push origin main as destructive", () => {
    const result = classifyCommand("git push origin main");
    expect(result.classification).toBe("destructive");
  });

  it("marks git commit as destructive", () => {
    const result = classifyCommand("git commit -m 'wip'");
    expect(result.classification).toBe("destructive");
  });

  it("marks pnpm install as destructive", () => {
    const result = classifyCommand("pnpm install");
    expect(result.classification).toBe("destructive");
  });

  it("marks node script execution as destructive", () => {
    const result = classifyCommand("node scripts/migrate.js");
    expect(result.classification).toBe("destructive");
  });

  it("marks sed -i as destructive", () => {
    const result = classifyCommand("sed -i 's/foo/bar/g' file.ts");
    expect(result.classification).toBe("destructive");
  });

  // Compound commands — worst classification wins
  it("blocks a compound command if any segment is blocked", () => {
    const result = classifyCommand("git status && rm -rf /");
    expect(result.classification).toBe("blocked");
  });

  it("marks compound as destructive if any segment is destructive and none blocked", () => {
    const result = classifyCommand("git log && git commit -m 'fix'");
    expect(result.classification).toBe("destructive");
  });
});
