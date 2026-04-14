import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { join } from "path";
import type { RunState, Budget, StepRecord } from "../types.js";

const DEFAULT_BUDGET: Budget = {
  maxIterations: 8,
  maxCostUsd: 20,
  maxWallSeconds: 3600,
  maxTokens: 1_000_000,
  spent: { costUsd: 0, wallSeconds: 0, tokens: 0 },
};

export async function createRunState(params: {
  runId: string;
  workflow: string;
  goal: string;
  budget: Partial<Budget>;
}): Promise<RunState> {
  const now = new Date().toISOString();
  return {
    runId: params.runId,
    workflow: params.workflow,
    goal: params.goal,
    status: "pending",
    currentStep: "plan",
    iteration: 0,
    budget: {
      ...DEFAULT_BUDGET,
      ...params.budget,
      spent: { costUsd: 0, wallSeconds: 0, tokens: 0 },
    },
    steps: [],
    artifacts: {},
    approvals: [],
    planMode: true,
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveRunState(runsDir: string, state: RunState): Promise<void> {
  const runDir = join(runsDir, state.runId);
  await mkdir(runDir, { recursive: true });
  const stateFile = join(runDir, "state.json");
  const tmpFile = join(runDir, "state.json.tmp");
  const updated = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(tmpFile, JSON.stringify(updated, null, 2));
  await rename(tmpFile, stateFile);
}

export async function loadRunState(runsDir: string, runId: string): Promise<RunState | null> {
  try {
    const stateFile = join(runsDir, runId, "state.json");
    const raw = await readFile(stateFile, "utf8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export function updateStep(state: RunState, stepName: string, record: Partial<StepRecord>): RunState {
  const existing = state.steps.findIndex(s => s.name === stepName);
  const updated = [...state.steps];
  if (existing === -1) {
    updated.push({ name: stepName, ...record });
  } else {
    updated[existing] = { ...updated[existing], ...record };
  }
  return { ...state, steps: updated };
}
