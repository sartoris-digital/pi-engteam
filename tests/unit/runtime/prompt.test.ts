import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptPointer, requiredFinalAction, stepPromptPath, writeStepPrompt } from "../../../src/runtime/prompt.js";

describe("writeStepPrompt", () => {
  let runsDir: string;
  let runDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "pi-sdlc-prompt-"));
    runDir = join(runsDir, "run-p1");
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  it("writes <runDir>/steps/<stage>-r<round>.prompt.md with the marker first and the final-action sentence last", async () => {
    const path = await writeStepPrompt(runDir, "implement", "Do the thing.\n", 2);
    expect(path).toBe(join(runDir, "steps", "implement-r2.prompt.md"));
    expect(path).toBe(stepPromptPath(runDir, "implement", 2));
    const text = await readFile(path, "utf8");
    expect(text).toBe(
      '<!-- pi-sdlc-factory generated · run run-p1 · do not commit -->\nDo the thing.\n\nREQUIRED FINAL ACTION: call VerdictEmit with step="implement"\n',
    );
  });

  it("defaults to round 1", async () => {
    expect(await writeStepPrompt(runDir, "plan", "x")).toBe(join(runDir, "steps", "plan-r1.prompt.md"));
  });

  it("does not duplicate a marker or final-action sentence already present", async () => {
    const body = `<!-- pi-sdlc-factory generated · run run-p1 · do not commit -->\nBody\n\n${requiredFinalAction("review")}\n`;
    const text = await readFile(await writeStepPrompt(runDir, "review", body), "utf8");
    expect(text.split("<!-- pi-sdlc-factory generated")).toHaveLength(2);
    expect(text.split("REQUIRED FINAL ACTION")).toHaveLength(2);
    expect(text).toBe(body);
  });

  it("rejects stage names that could escape the steps directory", async () => {
    await expect(writeStepPrompt(runDir, "../x", "y")).rejects.toThrow(/invalid stage name/);
    await expect(writeStepPrompt(runDir, "a b", "y")).rejects.toThrow(/invalid stage name/);
  });
});

describe("promptPointer", () => {
  it("tells the worker where the prompt is and how to finish", () => {
    expect(promptPointer("/r/steps/plan-r1.prompt.md")).toBe(
      "Read /r/steps/plan-r1.prompt.md and execute it. Finish by calling VerdictEmit.",
    );
  });
});
