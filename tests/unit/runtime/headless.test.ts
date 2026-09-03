import { describe, it, expect, afterEach } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXTENSION_ENTRY, HeadlessExecutor } from "../../../src/runtime/headless.js";
import { verdictFilePath } from "../../../src/runtime/env.js";
import { writeStepPrompt } from "../../../src/runtime/prompt.js";
import type { WorkerRequest } from "../../../src/runtime/types.js";
import { makeWorkerRequest } from "../../helpers/worker-request.js";

const STUB_SRC = fileURLToPath(new URL("../../helpers/stub-pi.mjs", import.meta.url));

interface Fixture {
  root: string;
  runsDir: string;
  runDir: string;
  ws: string;
  promptPath: string;
  scenarioPath: string;
  stub: string;
}

async function fixture(scenario: Record<string, unknown>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-sdlc-headless-"));
  const runsDir = join(root, "runs");
  const runDir = join(runsDir, "run-h1");
  const ws = join(root, "ws");
  await mkdir(ws, { recursive: true });
  const promptPath = await writeStepPrompt(runDir, "implement", "Create hello.txt.");
  const scenarioPath = join(root, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const stub = join(root, "stub-pi.mjs");
  await copyFile(STUB_SRC, stub);
  await chmod(stub, 0o755);
  return { root, runsDir, runDir, ws, promptPath, scenarioPath, stub };
}

function request(f: Fixture | undefined, overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  if (f === undefined) throw new Error("fixture not initialized");

  return makeWorkerRequest({
    runId: "run-h1",
    runDir: f.runDir,
    runsDir: f.runsDir,
    promptPath: f.promptPath,
    cwd: f.ws,
    projectRoot: f.root,
    piBinary: f.stub,
    timeoutMs: 10_000,
    ...overrides,
  });
}

function executor(f: Fixture | undefined, extra: ConstructorParameters<typeof HeadlessExecutor>[0] = {}): HeadlessExecutor {
  if (f === undefined) throw new Error("fixture not initialized");

  return new HeadlessExecutor({
    sandbox: null,
    extraEnv: { PI_SDLC_STUB_SCENARIO: f.scenarioPath },
    baseEnv: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: f.root, TMPDIR: tmpdir() },
    pollMs: 20,
    killGraceMs: 500,
    ...extra,
  });
}

describe("HeadlessExecutor", () => {
  let f: Fixture | undefined;
  afterEach(async () => {
    if (f?.root) await rm(f.root, { recursive: true, force: true });
    f = undefined;
  });

  it("resolves the extension entry to src/index.ts", () => {
    expect(DEFAULT_EXTENSION_ENTRY.endsWith(join("src", "index.ts"))).toBe(true);
  });

  it("spawns pi -p with the prompt pointer and returns the verdict the worker wrote", async () => {
    f = await fixture({ implement: { verdict: "PASS", files: { "hello.txt": "hi\n" }, commit_message: "feat: hello" } });
    let seen: { pid: number; argv: string[]; startedAt: string } | undefined;
    const result = await executor(f, { onSpawn: (info) => (seen = info) }).run(request(f));
    // stub-pi always writes issues/artifacts/changedFiles; assert the contract fields the scenario set.
    expect(result.verdict).toMatchObject({ step: "implement", verdict: "PASS", commit_message: "feat: hello" });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(await readFile(join(f.ws, "hello.txt"), "utf8")).toBe("hi\n");
    expect(seen?.pid).toBeGreaterThan(0);
    expect(seen?.argv).toEqual([
      f.stub,
      "-p",
      "--no-session",
      "-e",
      DEFAULT_EXTENSION_ENTRY,
      `Read ${f.promptPath} and execute it. Finish by calling VerdictEmit.`,
    ]);
  });

  it("removes a stale verdict slot before spawning", async () => {
    f = await fixture({ implement: { verdict: "PASS", noVerdict: true } });
    const slot = verdictFilePath(f.runDir, "implement", 1);
    await mkdir(dirname(slot), { recursive: true });
    await writeFile(slot, JSON.stringify({ step: "implement", verdict: "PASS" }));
    const result = await executor(f).run(request(f));
    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stderrTail).toBe("");
  });

  it("kills the process group on timeout and never returns a verdict", async () => {
    f = await fixture({ implement: { verdict: "PASS", noVerdict: true, sleepMs: 20_000 } });
    const started = Date.now();
    const result = await executor(f).run(request(f, { timeoutMs: 300 }));
    expect(result.timedOut).toBe(true);
    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBeNull();
    expect(result.stderrTail).toContain("timed out after 300 ms");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops when the abort signal fires", async () => {
    f = await fixture({ implement: { verdict: "PASS", noVerdict: true, sleepMs: 20_000 } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    const result = await executor(f).run(request(f, { signal: ac.signal }));
    expect(result.timedOut).toBe(false);
    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects when the prompt file does not exist", async () => {
    f = await fixture({ implement: { verdict: "PASS" } });
    await expect(executor(f).run(request(f, { promptPath: join(f.runDir, "steps", "missing.prompt.md") }))).rejects.toThrow(/ENOENT/);
  });

  it("reports a spawn failure in the stderr tail instead of hanging", async () => {
    f = await fixture({ implement: { verdict: "PASS" } });
    const result = await executor(f).run(request(f, { piBinary: join(f.root, "no-such-pi") }));
    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBeNull();
    expect(result.stderrTail).toMatch(/\[spawn\] .*ENOENT/);
  });
});
