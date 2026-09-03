import { join } from "node:path";
import type { RunContext } from "../../src/safety/context.js";

export interface FakePathEnv {
  home: string;
  factoryHome: string;
  verdictFile?: string;
}

export function fakePathEnv(over: Partial<FakePathEnv> = {}): FakePathEnv {
  return { home: "/Users/op", factoryHome: "/Users/op/.pi/sdlc-factory", ...over };
}

export function fakeRunContext(over: Partial<RunContext> = {}): RunContext {
  const runId = over.runId ?? "run-0001";
  const runsDir = over.runsDir ?? "/Users/op/.pi/sdlc-factory/runs";
  return {
    runId,
    runsDir,
    runDir: join(runsDir, runId),
    stage: "implement",
    agent: "implementer",
    workspaceDir: "/repos/app",
    projectRoot: "/repos/app-main",
    policyFile: join(runsDir, "_factory", "policy", "abc.yaml"),
    policySha: "a".repeat(64),
    extraUpsert: [],
    denyUpsert: [],
    nonce: "n0nce",
    ...over,
  };
}

export function completeWorkerEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PI_SDLC_AGENT_MODE: "1",
    PI_SDLC_RUN_ID: "run-0001",
    PI_SDLC_RUNS_DIR: "/Users/op/.pi/sdlc-factory/runs",
    PI_SDLC_STEP: "implement",
    PI_SDLC_AGENT: "implementer",
    PI_SDLC_WORKSPACE_DIR: "/repos/app",
    PI_SDLC_PROJECT_ROOT: "/repos/app-main",
    PI_SDLC_POLICY_FILE: "/Users/op/.pi/sdlc-factory/runs/_factory/policy/abc.yaml",
    PI_SDLC_POLICY_SHA: "a".repeat(64),
    PI_SDLC_NONCE: "n0nce",
    ...over,
  };
}
