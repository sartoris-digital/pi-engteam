import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_POLICY, type DomainPolicy } from "../../../src/safety/layer-d.js";
import { NO_TOKENS } from "../../../src/safety/layer-c.js";
import { installControllerHardBlockers, installSafetyGuard, readRunSecretSync, type GuardHost, type ToolCallBlock, type ToolCallEventLike } from "../../../src/safety/guard.js";
import { hashArgs, mintToken } from "../../../src/safety/tokens.js";
import * as safety from "../../../src/safety/index.js";
import { fakePathEnv, fakeRunContext } from "../../helpers/run-context.js";

type Handler = (event: ToolCallEventLike, ctx: unknown) => ToolCallBlock | undefined | Promise<ToolCallBlock | undefined>;

function fakePi(): { pi: GuardHost; handlers: Handler[]; events: string[] } {
  const handlers: Handler[] = [];
  const events: string[] = [];
  const pi = {
    on: (event: string, handler: unknown) => {
      events.push(event);
      if (event === "tool_call") handlers.push(handler as Handler);
    },
  };
  return { pi: pi as unknown as GuardHost, handlers, events };
}

function toolCall(toolName: string, input: Record<string, unknown>): ToolCallEventLike {
  return { type: "tool_call", toolCallId: "tc-1", toolName, input };
}

const env = fakePathEnv();
const IMPLEMENTER_POLICY: DomainPolicy = { readRoots: [], upsertRoots: ["src/"], deleteRoots: ["src/"], denyUpsert: ["tests/**"], bashPolicy: "full" };

describe("installSafetyGuard", () => {
  it("registers nothing without a run context, so other extensions' tool calls pass untouched", () => {
    const { pi, events } = fakePi();
    expect(installSafetyGuard(pi, null)).toBeNull();
    expect(events).toEqual([]);
  });

  it("registers exactly one tool_call handler that runs A → B → C → D", async () => {
    const { pi, handlers, events } = fakePi();
    const ctx = fakeRunContext();
    const guard = installSafetyGuard(pi, ctx, { policy: IMPLEMENTER_POLICY, tokens: NO_TOKENS, env });
    expect(guard).not.toBeNull();
    expect(events).toEqual(["tool_call"]);
    expect(handlers).toHaveLength(1);
    const handler = handlers[0] as Handler;

    const a = await handler(toolCall("bash", { command: "rm -rf /" }), {});
    expect(a).toEqual({ block: true, reason: expect.stringMatching(/^\[Layer A\]/), terminate: true });

    expect(await handler(toolCall("bash", { command: "ls -la" }), {})).toBeUndefined();
    expect(await handler(toolCall("read", { path: "src/a.ts" }), {})).toBeUndefined();

    const c = await handler(toolCall("bash", { command: "git commit -m x" }), {});
    expect(c).toEqual({ block: true, reason: expect.stringMatching(/^\[Layer C\]/), terminate: false });

    expect(await handler(toolCall("write", { path: "src/a.ts", content: "" }), {})).toBeUndefined();
    const d = await handler(toolCall("write", { path: "lib/a.ts", content: "" }), {});
    expect(d).toEqual({ block: true, reason: expect.stringMatching(/^\[Layer D\]/), terminate: false });
    const denied = await handler(toolCall("write", { path: "tests/a.test.ts", content: "" }), {});
    expect(denied?.reason).toMatch(/^\[Layer D\].*denied/);

    expect(await handler(toolCall("VerdictEmit", { step: "implement", verdict: "PASS" }), {})).toBeUndefined();
    expect(guard?.stats).toEqual({ evaluated: 8, blocked: { A: 1, B: 0, C: 1, D: 2 } });
    expect(guard?.policyError).toBeNull();
  });

  it("applies Layer B before C and D for read-only agents", async () => {
    const { pi, handlers } = fakePi();
    const ctx = fakeRunContext({ agent: "reviewer", stage: "review" });
    const guard = installSafetyGuard(pi, ctx, { policy: { ...EMPTY_POLICY, upsertRoots: ["${RUN_DIR}/review.md"], bashPolicy: "read-only" }, tokens: NO_TOKENS, env });
    const handler = handlers[0] as Handler;
    const b = await handler(toolCall("write", { path: "src/a.ts", content: "" }), {});
    expect(b?.reason).toMatch(/^\[Layer B\]/);
    expect(await handler(toolCall("write", { path: `${ctx.runDir}/review.md`, content: "" }), {})).toBeUndefined();
    const d = await handler(toolCall("write", { path: `${ctx.runDir}/other.md`, content: "" }), {});
    expect(d?.reason).toMatch(/^\[Layer D\]/);
    expect(await handler(toolCall("bash", { command: "git status" }), {})).toBeUndefined();
    expect((await handler(toolCall("bash", { command: "git commit -m x" }), {}))?.reason).toMatch(/^\[Layer B\]/);
    expect(guard?.stats.blocked).toEqual({ A: 0, B: 2, C: 0, D: 1 });
  });

  it("loads the policy and the run secret from the run dir and consumes real tokens", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-guard-"));
    try {
      const runsDir = join(tmp, "runs");
      const runDir = join(runsDir, "run-0001");
      const workspaceDir = join(tmp, "ws");
      await mkdir(join(runDir), { recursive: true });
      await mkdir(join(workspaceDir, "src"), { recursive: true });
      const policyText = ["schemaVersion: 1", "agents:", "  implementer:", '    upsert: ["src/"]', "    bash: full", ""].join("\n");
      const policyFile = join(runsDir, "_factory", "policy.yaml");
      await mkdir(join(runsDir, "_factory"), { recursive: true });
      await writeFile(policyFile, policyText);
      const secret = "f".repeat(64);
      await writeFile(join(runDir, ".secret"), `${secret}\n`, { mode: 0o600 });
      expect(readRunSecretSync(runDir)).toBe(secret);
      expect(readRunSecretSync(join(tmp, "nope"))).toBeNull();
      const ctx = fakeRunContext({
        runsDir, runDir, workspaceDir, projectRoot: join(tmp, "main"), policyFile,
        policySha: createHash("sha256").update(policyText).digest("hex"),
      });
      const localEnv = { home: join(tmp, "home"), factoryHome: join(tmp, "home", ".pi", "sdlc-factory") };
      const { pi, handlers } = fakePi();
      const guard = installSafetyGuard(pi, ctx, { env: localEnv });
      expect(guard?.policyError).toBeNull();
      const handler = handlers[0] as Handler;
      expect(await handler(toolCall("write", { path: "src/a.ts", content: "" }), {})).toBeUndefined();
      expect((await handler(toolCall("write", { path: "lib/a.ts", content: "" }), {}))?.reason).toMatch(/^\[Layer D\]/);
      expect((await handler(toolCall("bash", { command: "git commit -m x" }), {}))?.reason).toMatch(/^\[Layer C\]/);
      mintToken(runDir, secret, { op: "bash", argsHash: hashArgs("bash", { command: "git commit -m x" }), ttlSeconds: 60 });
      expect(await handler(toolCall("bash", { command: "git commit -m x" }), {})).toBeUndefined();
      expect((await handler(toolCall("bash", { command: "git commit -m x" }), {}))?.reason).toMatch(/^\[Layer C\]/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the policy cannot be loaded", async () => {
    const { pi, handlers } = fakePi();
    const ctx = fakeRunContext({ policyFile: "/nonexistent/policy.yaml" });
    const guard = installSafetyGuard(pi, ctx, { tokens: NO_TOKENS, env });
    expect(guard?.policyError).toMatch(/nonexistent/);
    const handler = handlers[0] as Handler;
    for (const tool of ["read", "grep", "glob", "find", "ls", "write", "edit", "bash"]) {
      const input = tool === "bash" ? { command: "ls" } : { path: "src/a.ts" };
      expect((await handler(toolCall(tool, input), {}))?.reason, tool).toMatch(/^\[Layer D\] policy unavailable/);
    }
  });

  it("fails closed on malformed YAML and SHA mismatch for every read and write tool", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-policy-err-"));
    try {
      const badFile = join(tmp, "bad.yaml");
      await writeFile(badFile, "schemaVersion: 2\nagents: {}\n");
      const goodText = ["schemaVersion: 1", "agents:", "  implementer:", '    upsert: ["src/"]', "    bash: full", ""].join("\n");
      const goodFile = join(tmp, "good.yaml");
      await writeFile(goodFile, goodText);
      const sha = createHash("sha256").update(goodText).digest("hex");

      for (const ctx of [
        fakeRunContext({ policyFile: badFile, policySha: sha }),
        fakeRunContext({ policyFile: goodFile, policySha: "0".repeat(64) }),
      ]) {
        const { pi, handlers } = fakePi();
        const guard = installSafetyGuard(pi, ctx, { tokens: NO_TOKENS, env });
        expect(guard?.policyError).toMatch(/\S/);
        const handler = handlers[0] as Handler;
        expect((await handler(toolCall("read", { path: "/Users/op/private-notes.txt" }), {}))?.reason).toMatch(/policy unavailable/);
        for (const tool of ["grep", "glob", "find", "ls"]) {
          expect((await handler(toolCall(tool, { path: "src/a.ts" }), {}))?.reason, tool).toMatch(/policy unavailable/);
        }
        expect((await handler(toolCall("write", { path: "src/a.ts", content: "" }), {}))?.reason).toMatch(/policy unavailable/);
        expect((await handler(toolCall("bash", { command: "ls" }), {}))?.reason).toMatch(/policy unavailable/);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the run secret is missing: destructive commands are always denied", async () => {
    const { pi, handlers } = fakePi();
    const ctx = fakeRunContext({ runDir: "/nonexistent/runs/run-0001", runsDir: "/nonexistent/runs" });
    installSafetyGuard(pi, ctx, { policy: IMPLEMENTER_POLICY, env });
    const handler = handlers[0] as Handler;
    expect((await handler(toolCall("bash", { command: "git commit -m x" }), {}))?.reason).toMatch(/^\[Layer C\]/);
    expect(await handler(toolCall("bash", { command: "git status" }), {})).toBeUndefined();
  });
});

describe("installControllerHardBlockers", () => {
  it("blocks only the vault, keyring and factory-home paths and never terminates", async () => {
    const { pi, handlers, events } = fakePi();
    installControllerHardBlockers(pi, env);
    expect(events).toEqual(["tool_call"]);
    const handler = handlers[0] as Handler;
    const vault = await handler(toolCall("read", { path: `${env.factoryHome}/vault.sqlite` }), {});
    expect(vault).toEqual({ block: true, reason: expect.stringMatching(/^\[Layer A\]/), terminate: false });
    expect((await handler(toolCall("bash", { command: "cat ~/.pi/sdlc-factory/runs/_factory/queue.json" }), {}))?.block).toBe(true);
    expect((await handler(toolCall("read", { path: "~/Library/Keychains/login.keychain-db" }), {}))?.block).toBe(true);
    expect(await handler(toolCall("bash", { command: "git push --force origin main" }), {})).toBeUndefined();
    expect(await handler(toolCall("bash", { command: "rm -rf /" }), {})).toBeUndefined();
    expect(await handler(toolCall("write", { path: "/repos/app/src/a.ts", content: "" }), {})).toBeUndefined();
    expect(await handler(toolCall("other_extension_tool", { x: 1 }), {})).toBeUndefined();
  });
});

describe("codex G2 installed-guard regressions", () => {
  it("blocks unsupported shell constructs for a read-only reviewer", async () => {
    const { pi, handlers } = fakePi();
    const ctx = fakeRunContext({ agent: "reviewer", stage: "review" });
    installSafetyGuard(pi, ctx, {
      policy: { readRoots: ["src/"], upsertRoots: [`${ctx.runDir}/review.md`], deleteRoots: [], denyUpsert: [], bashPolicy: "read-only" },
      tokens: NO_TOKENS,
      env,
    });
    const handler = handlers[0] as Handler;
    for (const cmd of [
      "echo ok & rm -rf src",
      "echo ok\ngit push origin HEAD",
      "echo $(gh pr create --fill)",
      "echo `env`",
    ]) {
      const result = await handler(toolCall("bash", { command: cmd }), {});
      expect(result?.block, cmd).toBe(true);
      expect(result?.reason, cmd).toMatch(/^\[Layer [ABCD]\]/);
    }
  });

  it("blocks attached redirects and unconfined write-flag verbs", async () => {
    const { pi, handlers } = fakePi();
    const ctx = fakeRunContext();
    installSafetyGuard(pi, ctx, { policy: IMPLEMENTER_POLICY, tokens: NO_TOKENS, env });
    const handler = handlers[0] as Handler;
    for (const cmd of [
      "echo pwned>/tmp/out",
      `echo pwned>${env.factoryHome}/vault.sqlite`,
      "sort -o /tmp/out package.json",
      "git diff --output=/tmp/out",
      "tsc --outDir /tmp/out",
      "pnpm run anything",
    ]) {
      const result = await handler(toolCall("bash", { command: cmd }), {});
      expect(result?.block, cmd).toBe(true);
    }
  });

  it("allows implementer write under extraUpsert writeRoots and terminates git push even with a token", async () => {
    const { pi, handlers } = fakePi();
    const ctx = fakeRunContext({ extraUpsert: ["src/**"], denyUpsert: ["tests/**"] });
    const always: typeof NO_TOKENS = {
      take: () => ({
        runId: "run-0001",
        tokenId: "stub",
        op: "bash",
        argsHash: "0".repeat(64),
        expiresAt: "2999-01-01T00:00:00.000Z",
        pauseEpoch: 0,
        sig: "0".repeat(64),
      }),
    };
    installSafetyGuard(pi, ctx, {
      policy: { readRoots: [], upsertRoots: [], deleteRoots: [], denyUpsert: [], bashPolicy: "full" },
      tokens: always,
      env,
    });
    const handler = handlers[0] as Handler;
    expect(await handler(toolCall("write", { path: "src/foo.ts", content: "" }), {})).toBeUndefined();
    const denied = await handler(toolCall("write", { path: "tests/a.test.ts", content: "" }), {});
    expect(denied?.block).toBe(true);
    expect(denied?.reason).toMatch(/^\[Layer D\]/);
    const push = await handler(toolCall("bash", { command: "git push origin HEAD" }), {});
    expect(push?.block).toBe(true);
    expect(push?.terminate).toBe(true);
    expect(push?.reason).toMatch(/^\[Layer A\].*git push is never allowed/);
  });

  it("does not let a matching token override Layer A force-push / git-dir", async () => {
    const { pi, handlers } = fakePi();
    const ctx = fakeRunContext();
    const always: typeof NO_TOKENS = {
      take: () => ({
        runId: "run-0001",
        tokenId: "stub",
        op: "bash",
        argsHash: "0".repeat(64),
        expiresAt: "2999-01-01T00:00:00.000Z",
        pauseEpoch: 0,
        sig: "0".repeat(64),
      }),
    };
    installSafetyGuard(pi, ctx, { policy: IMPLEMENTER_POLICY, tokens: always, env });
    const handler = handlers[0] as Handler;
    for (const cmd of [
      "git push origin HEAD",
      "git -c x=y push --force origin main",
      'git push "--force" origin main',
      "bash -c 'git push \"--force\" origin main'",
      "git push origin +HEAD:main",
      "git push --force-with-lease=main origin main",
      "git --git-dir=/repos/app/.git status",
      "GIT_DIR=/repos/app/.git git status",
    ]) {
      const result = await handler(toolCall("bash", { command: cmd }), {});
      expect(result?.block, cmd).toBe(true);
      expect(result?.terminate, cmd).toBe(true);
      expect(result?.reason, cmd).toMatch(/^\[Layer A\]/);
    }
  });
});

describe("index", () => {
  it("re-exports the public safety API and neither the shell helpers nor the shared canonicalJson", () => {
    for (const name of [
      "runContextFromEnv", "RunContextError", "generatedMarker", "parseRootList", "joinRootList", "fenceData", "fenceArray", "makeNonce",
      "signRecord", "verifyRecord", "mintToken", "consumeToken", "verifyToken", "hashArgs", "fileTokenSource",
      "isProtectedPath", "ORCH_OWNED", "PROTECTED_HOME_PATTERNS", "classifyBash", "hardBlock", "controllerHardBlock",
      "readOnlyBlock", "READ_ONLY_STAGE_CLASSES", "defaultDenyBlock", "NO_TOKENS", "domainBlock", "loadDomainPolicy",
      "parsePolicyFile", "policyForAgent", "installSafetyGuard", "installControllerHardBlockers", "evaluateToolCall", "readRunSecretSync",
    ]) {
      expect(typeof (safety as Record<string, unknown>)[name], name).not.toBe("undefined");
    }
    for (const name of ["splitSegments", "tokenize", "canonicalJson", "ROOT_LIST_SEPARATOR", "RUN_ID_PATTERN", "readRunSecret"]) {
      expect((safety as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});
