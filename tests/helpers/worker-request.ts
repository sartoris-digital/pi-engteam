import type { WorkerRequest } from "../../src/runtime/types.js";

export function makeWorkerRequest(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    runId: "run-test",
    runDir: "/tmp/pi-sdlc/runs/run-test",
    runsDir: "/tmp/pi-sdlc/runs",
    stage: "implement",
    round: 1,
    agent: {
      name: "implementer",
      model: "test-model",
      promptPath: "agents/implementer.md",
      tools: ["read", "write", "edit", "bash"],
      stageClass: "writer",
    },
    promptPath: "/tmp/pi-sdlc/runs/run-test/steps/implement-r1.prompt.md",
    cwd: "/tmp/pi-sdlc/ws",
    projectRoot: "/tmp/pi-sdlc/main",
    policyFile: "/tmp/pi-sdlc/runs/_factory/policy/abc.yaml",
    policySha: "abc",
    extraUpsert: ["docs/**", "README.md"],
    denyUpsert: ["tests/**"],
    nonce: "nonce-1",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    piBinary: "pi",
    ...overrides,
  };
}
