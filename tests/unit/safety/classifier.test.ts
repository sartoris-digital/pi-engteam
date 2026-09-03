import { describe, expect, it } from "vitest";
import { HARMLESS_REDIRECT_TARGETS, MAX_COMMAND_BYTES, classifyBash, fsEffectsKnown } from "../../../src/safety/classifier.js";

const cwd = "/repos/app";
const C = (command: string) => classifyBash(command, { cwd });

describe("classifyBash", () => {
  it.each([
    "ls -la", "git status", "git diff", "pnpm test", "vitest run", "cat src/a.ts",
    "echo hi > /dev/null", "git -C sub log", "git status && cat src/a.ts",
  ])("safe: %s", (cmd) => {
    expect(C(cmd).class, cmd).toBe("safe");
  });

  it.each([
    "git push origin HEAD", "git commit -m x", "gh pr create --fill", "printenv", "env", "set",
    "export -p", "declare -p", "echo hi > out.txt", "ls | tee out.txt", "git config user.name x",
    "git -c x=y status", "git worktree add ../x", "git remote add x y", "git stash",
    "npm install", "rm -rf build", "python x.py",
  ])("destructive: %s", (cmd) => {
    const c = C(cmd);
    expect(c.class, cmd).toBe("destructive");
    expect(c.reason, cmd).toMatch(/\S/);
  });

  it("treats git -C outside cwd as destructive and env dumps as destructive even when retired code called them safe", () => {
    expect(C("git -C /tmp log").class).toBe("destructive");
    expect(C("git -C .. log").class).toBe("destructive");
    expect(C("printenv").class).toBe("destructive");
    expect(HARMLESS_REDIRECT_TARGETS.has("/dev/null")).toBe(true);
    expect(C("x".repeat(MAX_COMMAND_BYTES + 1)).class).toBe("destructive");
  });

  it("does not treat git push as a known-confined fs effect", () => {
    expect(fsEffectsKnown("git", ["git", "status"])).toBe(true);
    expect(fsEffectsKnown("git", ["git", "commit", "-m", "x"])).toBe(true);
    expect(fsEffectsKnown("git", ["git", "push", "origin", "HEAD"])).toBe(false);
    expect(fsEffectsKnown("git", ["git", "-C", ".", "push", "origin", "HEAD"])).toBe(false);
  });

  it.each([
    "echo ok & rm -rf src",
    "echo ok\ngit push origin HEAD",
    "echo $(gh pr create --fill)",
    "echo `env`",
    "cat <(echo x)",
    "echo pwned>/tmp/out",
    "sort -o /tmp/out package.json",
    "git diff --output=/tmp/out",
    "tsc --outDir /tmp/out",
    "pnpm run anything",
    "npm run anything",
  ])("destructive (unknown / unconfined effects): %s", (cmd) => {
    const c = C(cmd);
    expect(c.class, cmd).toBe("destructive");
    expect(c.reason, cmd).toMatch(/\S/);
  });
});
