// tests/unit/safety/run-scoping.test.ts
//
// Regression: the controller-mode SafetyGuard registers a process-global
// `tool_call` hook that also fires for the bare operator session and for OTHER
// extensions' tool calls. Those callers don't know the Judge approval-token
// system and, with no interactive TUI, cannot satisfy an inline approval — so
// Layers B & C must be RUN-SCOPED: they only arbitrate while an engineering-team
// run is in flight. When idle, foreign tool calls fall through (subject only to
// Layer A catastrophic hard-blocks). See SafetyGuard.hasActiveRun.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { registerSafetyGuard } from "../../../src/safety/SafetyGuard.js";
import type { SafetyConfig } from "../../../src/types.js";

// Minimal pi mock: capture the tool_call handler so we can invoke it directly.
function makeGuard(runsDir: string) {
  let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
  const pi: any = {
    on: (event: string, h: any) => {
      if (event === "tool_call") handler = h;
    },
  };
  const config: SafetyConfig & { runsDir: string } = {
    hardBlockers: { enabled: true, alwaysOn: true },
    planMode: { defaultOn: false },
    classification: { mode: "default-deny", safeAllowlistExtend: [], destructiveOverride: [] },
    approvalAuthority: "judge",
    exemptPaths: [],
    tokenTtlSeconds: 3600,
    allowRunLifetimeScope: false,
    runsDir,
  };
  registerSafetyGuard(pi, config);
  if (!handler) throw new Error("guard did not register a tool_call handler");
  // Non-TUI controller context: no ctx.ui.custom → inline approval cannot run.
  return (event: any) => handler!(event, {});
}

async function markRunActive(runsDir: string, runId = "run-123"): Promise<void> {
  await writeFile(join(runsDir, "active-run.txt"), runId, "utf8");
  await mkdir(join(runsDir, runId), { recursive: true });
  await writeFile(join(runsDir, runId, "state.json"), JSON.stringify({ status: "running" }), "utf8");
}

describe("SafetyGuard run-scoping (controller mode)", () => {
  let runsDir: string;
  let savedRunId: string | undefined;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "pi-runscope-"));
    // Controller mode: PI_ENGINEERING_RUN_ID must be unset.
    savedRunId = process.env["PI_ENGINEERING_RUN_ID"];
    delete process.env["PI_ENGINEERING_RUN_ID"];
  });

  afterEach(async () => {
    if (savedRunId === undefined) delete process.env["PI_ENGINEERING_RUN_ID"];
    else process.env["PI_ENGINEERING_RUN_ID"] = savedRunId;
    await rm(runsDir, { recursive: true, force: true });
  });

  it("allows a foreign Write when NO run is active (Layer C not enforced)", async () => {
    const guard = makeGuard(runsDir);
    const result = await guard({
      toolName: "write",
      input: { file_path: join(tmpdir(), "some-other-extension-output.txt"), content: "x" },
    });
    expect(result).toBeUndefined();
  });

  it("allows a foreign destructive Bash when NO run is active", async () => {
    const guard = makeGuard(runsDir);
    const result = await guard({
      toolName: "bash",
      input: { command: "rm -rf ./build" },
    });
    expect(result).toBeUndefined();
  });

  it("still hard-blocks Layer A catastrophic patterns even when idle", async () => {
    const guard = makeGuard(runsDir);
    // tasks.json is a Layer A hard-block regardless of run state.
    const result = await guard({
      toolName: "bash",
      input: { command: "cat runs/tasks.json" },
    });
    expect(result?.block).toBe(true);
    expect(result?.layer).toBe("A");
  });

  it("blocks a Write at Layer C once a run IS active (no token, no TUI)", async () => {
    await markRunActive(runsDir);
    const guard = makeGuard(runsDir);
    const result = await guard({
      toolName: "write",
      input: { file_path: join(tmpdir(), "agent-output.txt"), content: "x" },
    });
    expect(result?.block).toBe(true);
    expect(result?.layer).toBe("C");
  });

  it("blocks a destructive Bash at Layer C once a run IS active", async () => {
    await markRunActive(runsDir);
    const guard = makeGuard(runsDir);
    const result = await guard({
      toolName: "bash",
      input: { command: "rm -rf ./build" },
    });
    expect(result?.block).toBe(true);
    expect(result?.layer).toBe("C");
  });

  it("does NOT scope away enforcement for a run whose state is unreadable (fail-closed)", async () => {
    // active-run.txt points at a run, but state.json is corrupt → hasActiveRun
    // fails closed (treats run as active) so the gate stays on.
    await writeFile(join(runsDir, "active-run.txt"), "run-corrupt", "utf8");
    await mkdir(join(runsDir, "run-corrupt"), { recursive: true });
    await writeFile(join(runsDir, "run-corrupt", "state.json"), "{ not json", "utf8");
    const guard = makeGuard(runsDir);
    const result = await guard({
      toolName: "bash",
      input: { command: "rm -rf ./build" },
    });
    // Gate stays ON: blocked at B (plan-mode also fails closed on corrupt
    // state) or C — the point is enforcement is NOT scoped away.
    expect(result?.block).toBe(true);
    expect(["B", "C"]).toContain(result?.layer);
  });
});
