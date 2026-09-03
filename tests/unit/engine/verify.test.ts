import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_DOC_PATTERNS } from "../../../src/config/defaults.js";
import { makeEngine } from "../../../src/controller/register.js";
import { defaultVerify } from "../../../src/engine/verify.js";
import { recordManifest } from "../../../src/gate/manifest.js";
import type { Step, StepContext, StepResult } from "../../../src/engine/types.js";
import type { Workspace } from "../../../src/workspace/types.js";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { fakeRunState } from "../../helpers/fake-run-state.js";
import { cleanupTmpDirs, makeStep, makeTestCfg, makeWorkflow, startParams, tmpRunsDir } from "./helpers.js";

afterEach(cleanupTmpDirs);

const PASS: StepResult = { verdict: "PASS" };
const STEP: Step = makeStep({ name: "implement", kind: "agent", agent: "implementer", verify: true });

function wsFor(path: string): Workspace {
  return {
    provider: "git",
    path,
    branch: "main",
    baseSha: "",
    repoRoot: path,
    gitCommonDir: join(path, ".git"),
    configSha: "",
  };
}

async function ctxFor(workspaceDir: string, over: { cfg?: Partial<ReturnType<typeof makeTestCfg>>; runDir?: string } = {}): Promise<StepContext> {
  const runDir = over.runDir ?? (await mkdtemp(join(tmpdir(), "sdlc-verify-run-")));
  const cfg = { ...makeTestCfg(workspaceDir), ...over.cfg };
  if (over.cfg?.generatedDocPatterns === undefined) cfg.generatedDocPatterns = [...GENERATED_DOC_PATTERNS];
  return {
    state: fakeRunState({
      runId: "run-verify",
      workspaceDir,
      mainCheckout: workspaceDir,
      currentStep: "implement",
    }),
    runDir,
    workspaceDir,
    cfg,
    nonce: "nonce-verify",
    emit: () => undefined,
    signal: new AbortController().signal,
  };
}

describe("defaultVerify", () => {
  it("PASSes a clean working tree", async () => {
    const fx = await makeFixtureRepo();
    try {
      const ctx = await ctxFor(fx.repo);
      const out = await defaultVerify(STEP, ctx, PASS);
      expect(out).toEqual({ verdict: "PASS" });
    } finally {
      await fx.cleanup();
    }
  });

  it("FAILs on unexpected dirty files and names the paths", async () => {
    const fx = await makeFixtureRepo();
    try {
      await writeFile(join(fx.repo, "src", "leftover.ts"), "export const leftover = 1;\n");
      const ctx = await ctxFor(fx.repo);
      const out = await defaultVerify(STEP, ctx, PASS);
      expect(out.verdict).toBe("FAIL");
      expect(out.escalate).toBeUndefined();
      expect(out.issues?.join("\n")).toMatch(/src\/leftover\.ts/);
    } finally {
      await fx.cleanup();
    }
  });

  it("ignores dirty generated docs", async () => {
    const fx = await makeFixtureRepo();
    try {
      await writeFile(join(fx.repo, "PLAN.md"), "# scratch plan\n");
      const ctx = await ctxFor(fx.repo);
      const out = await defaultVerify(STEP, ctx, PASS);
      expect(out).toEqual({ verdict: "PASS" });
    } finally {
      await fx.cleanup();
    }
  });

  it("still FAILs when generated docs are mixed with unexpected dirt", async () => {
    const fx = await makeFixtureRepo();
    try {
      await writeFile(join(fx.repo, "PLAN.md"), "# scratch plan\n");
      await writeFile(join(fx.repo, "src", "leftover.ts"), "export const leftover = 1;\n");
      const ctx = await ctxFor(fx.repo);
      const out = await defaultVerify(STEP, ctx, PASS);
      expect(out.verdict).toBe("FAIL");
      expect(out.issues?.join("\n")).toMatch(/src\/leftover\.ts/);
      expect(out.issues?.join("\n")).not.toMatch(/PLAN\.md/);
    } finally {
      await fx.cleanup();
    }
  });

  it("never returns PASS when the step timed out", async () => {
    const fx = await makeFixtureRepo();
    try {
      const ctx = await ctxFor(fx.repo);
      const out = await defaultVerify(STEP, ctx, { verdict: "PASS", evidence: { timedOut: true } });
      expect(out.verdict).toBe("FAIL");
      expect(out.issues?.join("\n")).toMatch(/timed out/i);
    } finally {
      await fx.cleanup();
    }
  });

  it("re-runs verifyManifestUnchanged and escalates test-tampering", async () => {
    const fx = await makeFixtureRepo();
    try {
      const runDir = await mkdtemp(join(tmpdir(), "sdlc-verify-man-"));
      const ws = wsFor(fx.repo);
      const manifest = await recordManifest(ws, "tests", []);
      const manifestPath = join(runDir, "test-manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const smoke = join(fx.repo, "tests", "smoke.test.ts");
      const prev = await readFile(smoke, "utf8");
      await writeFile(smoke, prev.replace('test("smoke: add"', 'test.skip("smoke: add"'));
      // Commit so dirty-tree does not mask the manifest check (engine checkpoints before verify).
      await fx.git(["add", "-A"]);
      await fx.git(["commit", "-q", "-m", "tamper tests"]);
      const ctx = await ctxFor(fx.repo, { runDir });
      const out = await defaultVerify(STEP, ctx, { verdict: "PASS", artifacts: { manifest: manifestPath } });
      expect(out.verdict).toBe("FAIL");
      expect(out.escalate).toBe("test-tampering");
      expect(out.issues?.join("\n")).toMatch(/skip/i);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("makeEngine verify wiring", () => {
  it("turns a dirty verify:true PASS into FAIL", async () => {
    const fx = await makeFixtureRepo();
    try {
      await writeFile(join(fx.repo, "src", "leftover.ts"), "export const leftover = 1;\n");
      const runsDir = await tmpRunsDir();
      const engine = makeEngine(runsDir, { coAuthoredBy: false });
      const steps = [
        makeStep({ name: "implement", kind: "agent", agent: "implementer", verify: true, onFail: "escalate:needs-decision" }),
        makeStep({ name: "escalate", host: "escalate" }),
      ];
      const cfg = makeTestCfg(fx.repo);
      cfg.generatedDocPatterns = [...GENERATED_DOC_PATTERNS];
      const run = await engine.startRun(
        startParams(makeWorkflow("ver", steps), { workspaceDir: fx.repo, mainCheckout: fx.repo, cfg }),
      );
      const final = await engine.executeRun(run.runId);
      expect(final.status).toBe("failed");
      expect(final.steps[0]?.verdict).toBe("FAIL");
      expect(final.steps[0]?.issues?.join("\n")).toMatch(/src\/leftover\.ts/);
    } finally {
      await fx.cleanup();
    }
  });
});
