import { describe, expect, it } from "vitest";
import {
  FakeToolRunner,
  GOLDEN_BUMP_INPUT,
  type ToolRunRequest,
} from "../../../src/codify/runner.js";

function req(over: Partial<ToolRunRequest> = {}): ToolRunRequest {
  return {
    toolPy: "tool.py",
    workspace: "/tmp/ws",
    input: { pkg: "fixture-app", version: "1.1.0" },
    class: "stage-tool",
    pythonhashseed: "0",
    ...over,
  };
}

describe("FakeToolRunner", () => {
  it("returns exit 0 and a patch for the golden bump-version input", async () => {
    const runner = new FakeToolRunner();
    const result = await runner.run(req({ input: { ...GOLDEN_BUMP_INPUT } }));
    expect(result.exitCode).toBe(0);
    expect(result.json?.ok).toBe(true);
    expect(result.json?.code).toBe(0);
    expect(result.json?.changedFiles).toContain("package.json");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toMatch(/package\.json/);
    expect(typeof result.json?.patchSha256).toBe("string");
    expect(result.json?.patchSha256?.length).toBe(64);
  });

  it("never includes secret values in stdout even if passed in secrets", async () => {
    const secret = "s3cret-value-do-not-leak";
    const runner = new FakeToolRunner();
    runner.register("/tmp/ws", { pkg: "x", version: "1.0.0" }, {
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, code: 0, token: secret, changedFiles: ["package.json"] }) + "\n",
      stderrTail: `debug ${secret}\n`,
      durationMs: 1,
      json: { ok: true, code: 0, changedFiles: ["package.json"] },
    });
    const result = await runner.run(
      req({
        input: { pkg: "x", version: "1.0.0" },
        secrets: { AEM_STAGING_TOKEN: secret },
        envNames: ["AEM_STAGING_TOKEN"],
      }),
    );
    expect(result.stdout).not.toContain(secret);
    expect(result.stderrTail).not.toContain(secret);
    expect(JSON.stringify(result.json)).not.toContain(secret);
  });
});
