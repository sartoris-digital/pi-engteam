import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { rm } from "fs/promises";
import {
  runVerifyLoop,
  _testing,
} from "../../../src/verifier/VerifierLoop.js";
import type { VerdictPayload } from "../../../src/types.js";

type DeliverArgs = { agent: string; message: any; opts?: any };

function makeMockTeam(responses: Array<(args: DeliverArgs) => Promise<VerdictPayload | undefined> | VerdictPayload | undefined>) {
  let callIdx = 0;
  const calls: DeliverArgs[] = [];
  const team: any = {
    deliver: vi.fn(async (agent: string, message: any, opts?: any) => {
      calls.push({ agent, message, opts });
      const fn = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      return await fn({ agent, message, opts });
    }),
    setRunId: vi.fn(),
    setStepContext: vi.fn(),
    markStepComplete: vi.fn(),
  };
  return { team, calls };
}

async function writeReport(runDir: string, step: string, iter: number, body: string) {
  const dir = join(runDir, "verification");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${step}-${iter}.md`), body);
}

describe("VerifierLoop", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verifier-loop-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true }).catch(() => {});
  });

  const baseVerdict: VerdictPayload = {
    step: "build",
    verdict: "PASS",
    artifacts: ["src/foo.ts"],
  };

  it("returns PASS on first verifier verdict", async () => {
    const { team, calls } = makeMockTeam([
      async () => ({ step: "verify:build", verdict: "PASS", artifacts: [] }),
    ]);
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r1",
      runDir,
      maxVerifyLoops: 3,
    });
    expect(res.verdict).toBe("PASS");
    // Empty issues → PERFECT confidence per inferConfidence rule.
    expect(res.confidence).toBe("PERFECT");
    expect(calls.length).toBe(1);
    expect(calls[0].agent).toBe("verifier");
  });

  it("on FAIL, sends a corrective SendMessage to the worker and re-dispatches the verifier", async () => {
    const { team, calls } = makeMockTeam([
      async () => {
        await writeReport(runDir, "build", 1, "STATUS: FAIL\nCONFIDENCE: FEEDBACK\n");
        return { step: "verify:build", verdict: "FAIL", issues: ["claim X failed"] };
      },
      // Worker re-iter must emit a fresh verdict: a silent worker now short-circuits
      // to auto-PASS (timeout resilience), so return a verdict to keep iterating.
      async () => ({ step: "build", verdict: "PASS", artifacts: ["fixed.ts"] }),
      async () => {
        await writeReport(runDir, "build", 2, "STATUS: PASS\nCONFIDENCE: PERFECT\n");
        return { step: "verify:build", verdict: "PASS" };
      },
    ]);
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r2",
      runDir,
      maxVerifyLoops: 3,
    });
    expect(res.verdict).toBe("PASS");
    expect(calls.length).toBe(3);
    expect(calls[0].agent).toBe("verifier");
    expect(calls[1].agent).toBe("implementer");
    expect(calls[1].message.message).toContain("claim X failed");
    expect(calls[2].agent).toBe("verifier");
  });

  it("on PARTIAL, invokes onPartialGap callback (single-writer policy) and returns PARTIAL", async () => {
    const onPartialGap = vi.fn();
    const { team } = makeMockTeam([
      async () => ({ step: "verify:build", verdict: "PARTIAL", issues: ["claim Y unverifiable"] }),
    ]);
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r3",
      runDir,
      maxVerifyLoops: 3,
      onPartialGap,
    });
    expect(res.verdict).toBe("PARTIAL");
    expect(onPartialGap).toHaveBeenCalledWith({
      step: "build",
      claim: "claim Y unverifiable",
      reason: "verifier reported PARTIAL",
    });
    // Codex round-1 P3 L-1: VerifierLoop no longer writes gaps.jsonl directly.
    // ADWEngine's onPartialGap callback is the sole writer.
  });

  it("returns FAIL (no longer throws) when all loops produce FAIL — GHCP resilience", async () => {
    const { team } = makeMockTeam([
      async () => {
        await writeReport(runDir, "build", 1, "STATUS: FAIL\nCONFIDENCE: FAILED\n");
        return { step: "verify:build", verdict: "FAIL", issues: ["x"] };
      },
      async () => ({ step: "build", verdict: "PASS", artifacts: ["a.ts"] }),
      async () => {
        await writeReport(runDir, "build", 2, "STATUS: FAIL\nCONFIDENCE: FAILED\n");
        return { step: "verify:build", verdict: "FAIL", issues: ["x", "y"] };
      },
      async () => ({ step: "build", verdict: "PASS", artifacts: ["a.ts"] }),
      async () => {
        await writeReport(runDir, "build", 3, "STATUS: FAIL\nCONFIDENCE: FAILED\n");
        return { step: "verify:build", verdict: "FAIL", issues: ["final"] };
      },
    ]);
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r4",
      runDir,
      maxVerifyLoops: 3,
    });
    // Exhaustion returns FAIL/FAILED (logged via exhausted.md) so the run can
    // continue to its workflow transitions instead of hard-throwing.
    expect(res.verdict).toBe("FAIL");
    expect(res.confidence).toBe("FAILED");
    expect(res.issues).toEqual(["final"]);
  });

  it("does not send corrective message after the final FAIL iteration", async () => {
    const { team, calls } = makeMockTeam([
      async () => {
        await writeReport(runDir, "build", 1, "STATUS: FAIL\nCONFIDENCE: FAILED\n");
        return { step: "verify:build", verdict: "FAIL", issues: ["x"] };
      },
      async () => ({ step: "build", verdict: "PASS", artifacts: ["a.ts"] }),
      async () => {
        await writeReport(runDir, "build", 2, "STATUS: FAIL\nCONFIDENCE: FAILED\n");
        return { step: "verify:build", verdict: "FAIL", issues: ["y"] };
      },
    ]);
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r5",
      runDir,
      maxVerifyLoops: 2,
    });
    expect(res.verdict).toBe("FAIL");
    // verifier(1) + worker(1) + verifier(2) = 3 calls; no worker reroute after the last FAIL
    expect(calls.map((c) => c.agent)).toEqual(["verifier", "implementer", "verifier"]);
  });

  it("auto-passes (timeout resilience) when the verifier returns no verdict", async () => {
    const { team } = makeMockTeam([async () => undefined]);
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r6",
      runDir,
      maxVerifyLoops: 3,
    });
    // A silent/timed-out verifier no longer throws — it auto-passes so the run continues.
    expect(res.verdict).toBe("PASS");
    expect(res.issues?.[0]).toMatch(/timed out/);
  });

  it("dispatches a verifier prompt that includes worker step and run id", async () => {
    const { team, calls } = makeMockTeam([
      async () => {
        await writeReport(runDir, "build", 1, "STATUS: PASS\nCONFIDENCE: VERIFIED\n");
        return { step: "verify:build", verdict: "PASS" };
      },
    ]);
    await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r7",
      runDir,
      maxVerifyLoops: 3,
    });
    const prompt = calls[0].message.message as string;
    expect(prompt).toContain("STEP: build");
    expect(prompt).toContain("RUN_ID: r7");
    expect(prompt).toContain("verifier-scripts");
    expect(calls[0].opts).toEqual({ runId: "r7" });
  });

  it("passes runId to both verifier and corrective worker dispatches", async () => {
    const { calls, team } = makeMockTeam([
      async () => ({ step: "verify:build", verdict: "FAIL", issues: ["claim X failed"] }),
      async () => ({ step: "build", verdict: "PASS", artifacts: ["fixed.ts"] }),
      async () => ({ step: "verify:build", verdict: "PASS" }),
    ]);

    await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r-threaded",
      runDir,
      maxVerifyLoops: 3,
    });

    expect(calls.map((c) => [c.agent, c.opts])).toEqual([
      ["verifier", { runId: "r-threaded" }],
      ["implementer", { hostStep: "build", runId: "r-threaded" }],
      ["verifier", { runId: "r-threaded" }],
    ]);
  });

  it("creates the verification report path even when verifier omits the file", async () => {
    const { team } = makeMockTeam([
      async () => ({ step: "verify:build", verdict: "PASS" }),
    ]);
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r8",
      runDir,
      maxVerifyLoops: 3,
    });
    expect(res.report).toContain("verification");
    const body = await readFile(res.report, "utf8");
    expect(body).toContain("STATUS: PASS");
  });

  it("infers CONFIDENCE from report STATUS lines", () => {
    expect(_testing.parseConfidenceFromReport("STATUS: PASS\nCONFIDENCE: PERFECT\n")).toBe("PERFECT");
    expect(_testing.parseConfidenceFromReport("nothing here")).toBeUndefined();
  });

  it("inferConfidence falls back when CONFIDENCE: line is absent", () => {
    expect(_testing.inferConfidence("PASS", [])).toBe("PERFECT");
    expect(_testing.inferConfidence("PASS", ["minor"])).toBe("VERIFIED");
    expect(_testing.inferConfidence("PARTIAL", [])).toBe("PARTIAL");
    expect(_testing.inferConfidence("FAIL", ["x"])).toBe("FEEDBACK");
    expect(_testing.inferConfidence("FAIL", [])).toBe("FAILED");
  });

  it("builds the verifier prompt from the worker verdict + artifacts (no session slice — TeamRuntime spawns with --no-session)", async () => {
    const { team, calls } = makeMockTeam([
      async () => ({ step: "verify:build", verdict: "PASS" }),
    ]);
    await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: { ...baseVerdict, artifacts: ["src/foo.ts", "tests/foo.test.ts"] },
      runId: "r9",
      runDir,
      maxVerifyLoops: 3,
    });
    const promptText = calls[0].message.message as string;
    expect(promptText).toContain("WORKER ARTIFACTS:");
    expect(promptText).toContain("src/foo.ts");
    expect(promptText).toContain("tests/foo.test.ts");
    // The session-slice scaffolding has been intentionally removed (Codex P3 H-3).
    expect(promptText).not.toContain("session slice");
  });

  it("sanitizes workerStep so path traversal cannot escape verificationDir (Codex round-2 NC-3)", async () => {
    const { team } = makeMockTeam([
      async () => ({ step: "verify:build", verdict: "PASS" }),
    ]);
    const evilStep = "../../escape";
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: evilStep,
      workerVerdict: baseVerdict,
      runId: "r-traversal",
      runDir,
      maxVerifyLoops: 3,
    });
    // Report path must stay under <runDir>/verification/. The filename component
    // (everything after the verification root) must not contain `..` segments.
    const verificationRoot = join(runDir, "verification");
    expect(res.report.startsWith(verificationRoot + "/")).toBe(true);
    const tail = res.report.slice(verificationRoot.length + 1);
    expect(tail.split("/").includes("..")).toBe(false);
  });

  it("re-iteration uses the worker's fresh verdict, not the original stale one (Codex P3 H-2)", async () => {
    const verifierCalls: any[] = [];
    const { team } = makeMockTeam([
      // First verifier pass — FAILs.
      async ({ message }) => {
        verifierCalls.push(message.message);
        return { step: "verify:build", verdict: "FAIL", issues: ["original issue"] };
      },
      // Worker re-iter — emits a corrected verdict.
      async () => ({
        step: "build",
        verdict: "PASS",
        artifacts: ["src/foo.ts", "src/CORRECTED.ts"],
      }),
      // Second verifier pass — should see the corrected artifacts.
      async ({ message }) => {
        verifierCalls.push(message.message);
        return { step: "verify:build", verdict: "PASS" };
      },
    ]);
    await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r-h2",
      runDir,
      maxVerifyLoops: 3,
    });
    expect(verifierCalls.length).toBe(2);
    expect(verifierCalls[0]).not.toContain("CORRECTED.ts");
    expect(verifierCalls[1]).toContain("CORRECTED.ts");
  });

  it("corrective message references the verifier issues and report path", () => {
    const msg = _testing.buildCorrectiveMessage({
      workerStep: "build",
      issues: ["foo failed at src/x.ts:10"],
      reportPath: "/tmp/report.md",
    });
    expect(msg).toContain("build");
    expect(msg).toContain("foo failed at src/x.ts:10");
    expect(msg).toContain("/tmp/report.md");
  });

  it("uses the provided maxVerifyLoops bound", async () => {
    const { team, calls } = makeMockTeam([
      async () => {
        await writeReport(runDir, "build", 1, "STATUS: FAIL\nCONFIDENCE: FAILED\n");
        return { step: "verify:build", verdict: "FAIL", issues: ["x"] };
      },
    ]);
    const res = await runVerifyLoop({
      team,
      verifierAgentName: "verifier",
      workerAgentName: "implementer",
      workerStep: "build",
      workerVerdict: baseVerdict,
      runId: "r11",
      runDir,
      maxVerifyLoops: 1,
    });
    expect(res.verdict).toBe("FAIL");
    // single iteration: only verifier called, no worker reroute
    expect(calls.map((c) => c.agent)).toEqual(["verifier"]);
  });
});
