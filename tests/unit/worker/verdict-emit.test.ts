import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createVerdictEmitTool, VERDICT_EMIT_TOOL_NAME } from "../../../src/worker/verdict-emit.js";
import { parseVerdict } from "../../../src/runtime/verdict.js";

const ctx = {} as unknown as ExtensionContext;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("VerdictEmit tool", () => {
  let dir: string;
  let verdictFile: string;
  let exits: number[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-sdlc-emit-"));
    verdictFile = join(dir, "_verdicts", "implement-r1.json");
    exits = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function tool() {
    return createVerdictEmitTool({ verdictFile, expectedStep: "implement", runId: "run-e1", exit: (code) => exits.push(code), exitDelayMs: 0 });
  }

  it("is registered under the contract name with the VerdictPayload schema", () => {
    const t = tool();
    expect(t.name).toBe(VERDICT_EMIT_TOOL_NAME);
    expect(t.parameters.properties.verdict).toBeDefined();
    expect(t.parameters.properties.step).toBeDefined();
  });

  it("writes the cleaned verdict atomically, marks the result terminal and schedules exit(0) once", async () => {
    const t = tool();
    const result = await t.execute("call-1", { step: "implement", verdict: "PASS", flags: ["x"], bogus: 1 } as never, undefined, undefined, ctx);
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ path: verdictFile, verdict: "PASS", duplicate: false });
    expect(result.content[0]).toEqual({ type: "text", text: 'Verdict PASS recorded for step "implement". The session will now end.' });
    const raw = JSON.parse(await readFile(verdictFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)[0]).toBe("_marker");
    expect(raw._marker).toBe("<!-- pi-sdlc-factory generated · run run-e1 · do not commit -->");
    expect(raw).not.toHaveProperty("bogus");
    expect(parseVerdict(await readFile(verdictFile, "utf8"))).toEqual({ ok: true, payload: { step: "implement", verdict: "PASS", flags: ["x"] } });
    expect((await stat(verdictFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "_verdicts"))).toEqual(["implement-r1.json"]);
    await tick();
    expect(exits).toEqual([0]);
  });

  it("treats a second call as a no-op that keeps the first verdict", async () => {
    const t = tool();
    await t.execute("call-1", { step: "implement", verdict: "FAIL", issues: ["a"] }, undefined, undefined, ctx);
    const second = await t.execute("call-2", { step: "implement", verdict: "PASS" }, undefined, undefined, ctx);
    expect(second.details.duplicate).toBe(true);
    expect(second.content[0]).toEqual({ type: "text", text: "Verdict already recorded (FAIL); no further action is needed." });
    expect(JSON.parse(await readFile(verdictFile, "utf8")).verdict).toBe("FAIL");
    await tick();
    expect(exits).toEqual([0]);
  });

  it("rejects a verdict for the wrong step and writes nothing", async () => {
    const t = tool();
    await expect(t.execute("call-1", { step: "review", verdict: "PASS" }, undefined, undefined, ctx)).rejects.toThrow(/step must be "implement"/);
    await expect(stat(verdictFile)).rejects.toMatchObject({ code: "ENOENT" });
    await tick();
    expect(exits).toEqual([]);
  });

  it("rejects payloads over the 256 KB cap", async () => {
    const t = tool();
    await expect(
      t.execute("call-1", { step: "implement", verdict: "PASS", learnings: ["x".repeat(256 * 1024)] }, undefined, undefined, ctx),
    ).rejects.toThrow(/exceeds 262144 bytes/);
  });

  it("uses a 250 ms exit delay by default", () => {
    const t = createVerdictEmitTool({ verdictFile, expectedStep: "implement", runId: "run-e1", exit: () => undefined });
    expect(t.description).toContain('step="implement"');
    expect(t.executionMode).toBe("sequential");
  });
});
