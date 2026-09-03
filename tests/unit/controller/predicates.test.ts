import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGates, allGatesOk } from "../../../src/controller/predicates.js";
import { makeRepoConfig, makeRunState } from "../../helpers/steer-fixtures.js";
import type { StepContext } from "../../../src/engine/types.js";

const JUNIT_GREEN = `<?xml version="1.0"?><testsuite name="t" tests="1" failures="0" errors="0"><testcase name="ok"/></testsuite>`;
const JUNIT_RED = `<?xml version="1.0"?><testsuite name="t" tests="1" failures="1" errors="0"><testcase name="bad"><failure/></testcase></testsuite>`;

function ctxFor(runDir: string, ws: string, over: Partial<StepContext> = {}): StepContext {
  const state = makeRunState({ runId: "run-1", workspaceDir: ws, judgedSha: "a".repeat(40) });
  return {
    state,
    runDir,
    workspaceDir: ws,
    cfg: makeRepoConfig({
      checks: [{ name: "vitest", argv: ["true"], reporter: "junit", timeoutSeconds: 30, junitPath: "reports/junit.xml" }],
    }),
    nonce: "n",
    emit: () => undefined,
    signal: new AbortController().signal,
    ...over,
  };
}

describe("evaluateGates", () => {
  let root: string;
  let runDir: string;
  let ws: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-sdlc-pred-"));
    runDir = join(root, "runs", "run-1");
    ws = join(root, "ws");
    await mkdir(join(ws, "reports"), { recursive: true });
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("junit-green requires the report to exist and have zero failures", async () => {
    const ctx = ctxFor(runDir, ws);
    expect((await evaluateGates(ctx, ["junit-green"], { verdict: "PASS" }))[0]?.ok).toBe(false);
    await writeFile(join(ws, "reports", "junit.xml"), JUNIT_RED);
    expect((await evaluateGates(ctx, ["junit-green"], { verdict: "PASS" }))[0]?.ok).toBe(false);
    await writeFile(join(ws, "reports", "junit.xml"), JUNIT_GREEN);
    expect((await evaluateGates(ctx, ["junit-green"], { verdict: "PASS" }))[0]?.ok).toBe(true);
  });

  it("sections: requires the named headings", async () => {
    const ctx = ctxFor(runDir, ws);
    await writeFile(join(runDir, "plan.md"), "## Goal\n## Files to touch\n");
    const miss = await evaluateGates(ctx, ["sections:plan.md:Goal,Files to touch,Steps"], { verdict: "PASS" });
    expect(miss[0]?.ok).toBe(false);
    await writeFile(join(runDir, "plan.md"), "## Goal\n## Files to touch\n## Steps\n");
    const hit = await evaluateGates(ctx, ["sections:plan.md:Goal,Files to touch,Steps"], { verdict: "PASS" });
    expect(hit[0]?.ok).toBe(true);
  });

  it("unknown predicates pass with a v0 note and allGatesOk is false when any fail", async () => {
    const ctx = ctxFor(runDir, ws);
    const results = await evaluateGates(ctx, ["citations", "junit-green"], { verdict: "PASS" });
    expect(results[0]).toMatchObject({ name: "citations", ok: true });
    expect(allGatesOk(results)).toBe(false);
  });
});
