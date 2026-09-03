import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../../../src/safety/context.js";
import { NO_TOKENS, defaultDenyBlock } from "../../../src/safety/layer-c.js";
import { fileTokenSource, hashArgs, mintToken, type ApprovalToken, type TokenSource } from "../../../src/safety/tokens.js";
import { fakePathEnv, fakeRunContext } from "../../helpers/run-context.js";

const env = fakePathEnv();
const ctx = fakeRunContext();
const C = (tool: string, input: Record<string, unknown>, tokens: TokenSource = NO_TOKENS, c: RunContext = ctx) =>
  defaultDenyBlock(tool, input, c, tokens, env);

function stubToken(op: ApprovalToken["op"], argsHash: string): ApprovalToken {
  return { runId: "run-0001", tokenId: "stub", op, argsHash, expiresAt: "2999-01-01T00:00:00.000Z", pauseEpoch: 0, sig: "0".repeat(64) };
}

describe("bash default-deny (spec §10.5)", () => {
  it.each([
    "git push origin HEAD", "git commit -m x", "gh pr create --fill", "printenv", "env", "set", "export -p", "declare -p",
    "echo hi > out.txt", "ls | tee out.txt", "git config user.name x", "git -c x=y status", "git worktree add ../x",
    "git remote add x y", "git stash", "npm install", "rm -rf build", "python x.py",
  ])("blocks %s without a token", (cmd) => {
    const block = C("bash", { command: cmd });
    expect(block?.layer, cmd).toBe("C");
    expect(block?.terminate, cmd).toBeUndefined();
    expect(block?.reason, cmd).toMatch(/^\[Layer C\].*approval token.*RequestApproval/s);
  });

  it.each(["ls -la", "git status", "git diff", "pnpm test", "vitest run", "cat src/a.ts", "echo hi > /dev/null", "git -C sub log"])(
    "passes %s",
    (cmd) => expect(C("bash", { command: cmd }), cmd).toBeNull(),
  );

  it("never classifies powershell safe and refuses a missing command", () => {
    expect(C("powershell", { command: "Get-ChildItem" })?.layer).toBe("C");
    expect(C("bash", {})?.layer).toBe("C");
  });

  it("ignores Layer D policy: no policy input can widen Layer C", () => {
    expect(C("bash", { command: "git push origin HEAD" }, NO_TOKENS, fakeRunContext({ extraUpsert: ["."] }))?.layer).toBe("C");
  });
});

describe("token consumption", () => {
  it("allows a destructive command exactly once when a matching token exists", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-layer-c-"));
    try {
      const runDir = join(tmp, "run-0001");
      await mkdir(runDir, { recursive: true });
      const c = fakeRunContext({ runDir, runsDir: tmp });
      const secret = "e".repeat(64);
      mintToken(runDir, secret, { op: "bash", argsHash: hashArgs("bash", { command: "git commit -m x" }), ttlSeconds: 60 });
      const tokens = fileTokenSource(runDir, secret, "run-0001");
      expect(C("bash", { command: "git commit -m y" }, tokens, c)?.layer).toBe("C");
      expect(C("bash", { command: "git commit -m x" }, tokens, c)).toBeNull();
      expect(C("bash", { command: "git commit -m x" }, tokens, c)?.layer).toBe("C");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("binds the token to the exact command string and the bash op", () => {
    const argsHash = hashArgs("bash", { command: "git commit -m x" });
    const tokens: TokenSource = { take: (op, h) => (op === "bash" && h === argsHash ? stubToken("bash", h) : null) };
    expect(C("bash", { command: "git commit -m x" }, tokens)).toBeNull();
    expect(C("bash", { command: "git commit -m x " }, tokens)?.layer).toBe("C");
    expect(C("bash", { command: "git commit -m x && git push" }, tokens)?.layer).toBe("C");
  });

  it("does not consume a token for a safe command", () => {
    let taken = 0;
    const tokens: TokenSource = { take: () => { taken++; return null; } };
    expect(C("bash", { command: "git status" }, tokens)).toBeNull();
    expect(taken).toBe(0);
  });
});

describe("write and edit", () => {
  it("passes writes inside the worktree or run dir and denies others without a token", () => {
    expect(C("write", { path: "src/a.ts", content: "" })).toBeNull();
    expect(C("write", { path: `${ctx.workspaceDir}/src/a.ts`, content: "" })).toBeNull();
    expect(C("edit", { path: `${ctx.runDir}/plan.md`, edits: [] })).toBeNull();
    expect(C("write", { path: "/nonexistent/leak.txt", content: "" })?.layer).toBe("C");
    expect(C("write", { path: "../ticket-9/x", content: "" })?.layer).toBe("C");
    expect(C("edit", { path: "~/notes.md", edits: [] })?.layer).toBe("C");
    expect(C("write", { content: "" })?.layer).toBe("C");
  });

  it("accepts a write token hashed over the resolved absolute path", () => {
    const abs = "/nonexistent/leak.txt";
    const argsHash = hashArgs("write", { path: abs });
    const tokens: TokenSource = { take: (op, h) => (op === "write" && h === argsHash ? stubToken("write", h) : null) };
    expect(C("write", { path: abs, content: "" }, tokens)).toBeNull();
    expect(C("edit", { path: abs, edits: [] }, tokens)?.layer).toBe("C");
  });

  it("ignores other tools", () => {
    expect(C("read", { path: "/nonexistent/x" })).toBeNull();
    expect(C("VerdictEmit", { step: "x" })).toBeNull();
  });
});
