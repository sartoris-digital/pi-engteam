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
    currentStep: "",  // L1: placeholder; ADWEngine.startRun overwrites with workflow.steps[0].name
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

// Codex Phase 4 round-3 C-1: per-runId in-process mutex serializes all
// load-modify-save cycles. Without this, a /run-cancel that lands between
// ADWEngine's loadRunState() and saveRunState() at a level boundary still
// gets clobbered by stale in-memory state. Both ADWEngine's terminal/level
// saves and /run-cancel itself wrap their read-modify-write sequence in
// withRunStateLock so writes are linearized within the process.
const runStateLocks = new Map<string, Promise<unknown>>();
export function withRunStateLock<T>(
  runsDir: string,
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${runsDir}::${runId}`;
  const prev = runStateLocks.get(key) ?? Promise.resolve();
  // Chain onto the previous turn regardless of its outcome — a prior failure
  // must not block subsequent saves.
  const next = prev.then(fn, fn);
  // Store a swallowed-error promise so unhandled rejections don't escape, but
  // return the unswallowed promise so the caller still sees the real error.
  runStateLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export async function loadRunState(runsDir: string, runId: string): Promise<RunState | null> {
  try {
    const stateFile = join(runsDir, runId, "state.json");
    const raw = await readFile(stateFile, "utf8");
    return JSON.parse(raw) as RunState;
  } catch (err) {
    // M2: distinguish a missing run (ENOENT) from a corrupt/unreadable state file
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `[pi-engineering] Failed to load run state for ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
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
