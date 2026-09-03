import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WORKER_REFUSED_EXIT_CODE, policyShaOf, registerWorker } from "../../../src/worker/register.js";
import { FakePi, type ToolCallEventLike } from "../../helpers/fake-pi.js";

const ctx = {} as unknown as ExtensionContext;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const bashCall: ToolCallEventLike = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls" } };

describe("registerWorker", () => {
  let root: string;
  let runDir: string;
  let policyFile: string;
  let policySha: string;
  let exits: number[];
  let logs: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-sdlc-register-"));
    runDir = join(root, "runs", "run-w1");
    await mkdir(join(runDir, "_verdicts"), { recursive: true });
    await mkdir(join(root, "ws"), { recursive: true });
    policyFile = join(root, "runs", "_factory", "policy", "snapshot.yaml");
    await mkdir(join(root, "runs", "_factory", "policy"), { recursive: true });
    await writeFile(
      policyFile,
      ["schemaVersion: 1", "agents:", "  implementer:", '    upsert: ["src/**"]', "    bash: full", "  reviewer:", "    bash: read-only", ""].join("\n"),
    );
    policySha = createHash("sha256").update(await readFile(policyFile)).digest("hex");
    exits = [];
    logs = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
      PI_SDLC_AGENT_MODE: "1",
      PI_SDLC_RUN_ID: "run-w1",
      PI_SDLC_RUNS_DIR: join(root, "runs"),
      PI_SDLC_STEP: "implement",
      PI_SDLC_AGENT: "implementer",
      PI_SDLC_VERDICT_FILE: join(runDir, "_verdicts", "implement-r1.json"),
      PI_SDLC_WORKSPACE_DIR: join(root, "ws"),
      PI_SDLC_PROJECT_ROOT: join(root, "main"),
      PI_SDLC_POLICY_FILE: policyFile,
      PI_SDLC_POLICY_SHA: policySha,
      PI_SDLC_EXTRA_UPSERT: "[]",
      PI_SDLC_DENY_UPSERT: "[]",
      PI_SDLC_NONCE: "nonce-w1",
      ...overrides,
    };
  }

  const opts = () => ({ exit: (code: number) => exits.push(code), log: (m: string) => logs.push(m) });

  it("computes the policy snapshot sha", async () => {
    expect(policyShaOf(policyFile)).toBe(policySha);
  });

  it("installs the safety guard and registers VerdictEmit, RequestApproval and AskHost", () => {
    const fake = new FakePi();
    const result = registerWorker(fake.asPi(), { env: env(), ...opts() });
    expect(result?.runId).toBe("run-w1");
    expect(result?.stage).toBe("implement");
    expect(fake.hasTool("VerdictEmit")).toBe(true);
    expect(fake.hasTool("RequestApproval")).toBe(true);
    expect(fake.hasTool("AskHost")).toBe(true);
    expect((fake.handlers.get("tool_call") ?? []).length).toBeGreaterThanOrEqual(1);
    expect(exits).toEqual([]);
  });

  it("wires VerdictEmit to PI_SDLC_VERDICT_FILE, the stage and the injected exit", async () => {
    const fake = new FakePi();
    registerWorker(fake.asPi(), { env: env(), ...opts() });
    const result = await fake.tool("VerdictEmit").execute("c1", { step: "implement", verdict: "PASS" }, undefined, undefined, ctx);
    expect(result.details.path).toBe(join(runDir, "_verdicts", "implement-r1.json"));
    expect(JSON.parse(await readFile(join(runDir, "_verdicts", "implement-r1.json"), "utf8")).verdict).toBe("PASS");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toEqual([0]);
  });

  it("wires RequestApproval to the run dir", async () => {
    const fake = new FakePi();
    registerWorker(fake.asPi(), { env: env(), ...opts() });
    const result = await fake.tool("RequestApproval").execute("c1", { op: "x", command: "y", justification: "z" }, undefined, undefined, ctx);
    const record = JSON.parse(await readFile(join(runDir, "approvals", "pending", `${result.details.requestId}.json`), "utf8"));
    expect(record).toMatchObject({ runId: "run-w1", stage: "implement", agent: "implementer" });
  });

  it("fails closed on a policy sha mismatch", async () => {
    const fake = new FakePi();
    const result = registerWorker(fake.asPi(), { env: env({ PI_SDLC_POLICY_SHA: "0".repeat(64) }), ...opts() });
    expect(result).toBeNull();
    expect(exits).toEqual([WORKER_REFUSED_EXIT_CODE]);
    expect(fake.tools).toEqual([]);
    expect(logs.join("\n")).toMatch(/policy snapshot sha mismatch/);
    const block = await fake.emit("tool_call", bashCall);
    expect(block).toMatchObject({ block: true, terminate: true });
    await tick();
  });

  it("fails closed when the policy file is unreadable", () => {
    const fake = new FakePi();
    registerWorker(fake.asPi(), { env: env({ PI_SDLC_POLICY_FILE: join(root, "missing.yaml") }), ...opts() });
    expect(exits).toEqual([WORKER_REFUSED_EXIT_CODE]);
    expect(logs.join("\n")).toMatch(/policy snapshot unreadable/);
  });

  it("fails closed on a malformed run context (RunContextError), never letting it escape", async () => {
    const fake = new FakePi();
    expect(registerWorker(fake.asPi(), { env: env({ PI_SDLC_EXTRA_UPSERT: "{not json" }), ...opts() })).toBeNull();
    expect(exits).toEqual([WORKER_REFUSED_EXIT_CODE]);
    expect(logs.join("\n")).toMatch(/run context is malformed/);
    expect(fake.tools).toEqual([]);
    expect(await fake.emit("tool_call", bashCall)).toMatchObject({ block: true });
  });

  it("fails closed without a run context or a verdict file", async () => {
    const a = new FakePi();
    expect(registerWorker(a.asPi(), { env: {}, ...opts() })).toBeNull();
    expect(exits).toEqual([WORKER_REFUSED_EXIT_CODE]);
    expect(await a.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "t1", input: { path: "x" } })).toMatchObject({ block: true });

    exits = [];
    const b = new FakePi();
    expect(registerWorker(b.asPi(), { env: env({ PI_SDLC_VERDICT_FILE: undefined }), ...opts() })).toBeNull();
    expect(exits).toEqual([WORKER_REFUSED_EXIT_CODE]);
    expect(logs.join("\n")).toMatch(/PI_SDLC_VERDICT_FILE/);
  });

  it("blocks write when PI_SDLC_TOOLS is a read-only list and allows implementer write", async () => {
    const reviewer = new FakePi();
    registerWorker(reviewer.asPi(), {
      env: env({ PI_SDLC_TOOLS: "read,grep,find", PI_SDLC_AGENT: "reviewer", PI_SDLC_STEP: "review" }),
      ...opts(),
    });
    const blocked = await reviewer.emit("tool_call", {
      type: "tool_call",
      toolName: "write",
      toolCallId: "t1",
      input: { path: "src/a.ts", content: "" },
    });
    expect(blocked).toMatchObject({ block: true });
    expect((blocked as { reason?: string }).reason).toMatch(/PI_SDLC_TOOLS allowlist/);
    expect(
      await reviewer.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "t2", input: { path: "src/a.ts" } }),
    ).toBeUndefined();

    const impl = new FakePi();
    registerWorker(impl.asPi(), { env: env({ PI_SDLC_TOOLS: "read,write,edit,bash" }), ...opts() });
    const allowed = await impl.emit("tool_call", {
      type: "tool_call",
      toolName: "write",
      toolCallId: "t1",
      input: { path: "src/a.ts", content: "" },
    });
    expect(allowed).toBeUndefined();
  });
});
