import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { join } from "path";
import type { RunState, Budget, StepRecord } from "../types.js";

// Phase 5.5 round-2 C1: centralized safe-runId guard. The same shape
// already used by /learn, /run-cancel, /run-rollback, and TaskList.
// Exported so other entry points (commands, /run-resume, etc.) can
// validate before path-joining or before passing runId on.
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isSafeRunId(runId: string): boolean {
  return typeof runId === "string" && RUN_ID_RE.test(runId);
}
function ensureSafeRunId(runId: string): void {
  if (!isSafeRunId(runId)) {
    throw new Error(`Refusing run-state access for unsafe runId: ${JSON.stringify(runId)}`);
  }
}

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
  ensureSafeRunId(state.runId);
  const runDir = join(runsDir, state.runId);
  await mkdir(runDir, { recursive: true });
  const stateFile = join(runDir, "state.json");
  const tmpFile = join(runDir, "state.json.tmp");
  const updated = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(tmpFile, JSON.stringify(updated, null, 2));
  await rename(tmpFile, stateFile);
}

// Codex Phase 4 round-3 C-1 / round-4 M-1: per-runId in-process mutex
// serializes all load-modify-save cycles. Without this, a /run-cancel that
// lands between ADWEngine's loadRunState() and saveRunState() at a level
// boundary still gets clobbered by stale in-memory state. Both ADWEngine's
// terminal/level saves and /run-cancel itself wrap their read-modify-write
// sequence in withRunStateLock so writes are linearized within the process.
//
// M-1: settled locks are dropped from the map so a long-running pi process
// doesn't accumulate one entry per runId forever.
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
  const tracked = next.catch(() => undefined);
  runStateLocks.set(key, tracked);
  // After this turn settles, drop the map entry IF no later waiter has
  // chained on top of us. Compare-and-delete via identity check.
  void tracked.finally(() => {
    if (runStateLocks.get(key) === tracked) {
      runStateLocks.delete(key);
    }
  });
  return next;
}

// Codex round-5 MEDIUM: state.json was cast via `as RunState` with no
// runtime validation. A crafted file with `budget:{}` or `steps:{}` would
// reach downstream code (BudgetGuard's spent.costUsd access, ADWEngine's
// state.steps.filter/findIndex) and crash.
//
// Strategy: validate the IDENTITY fields strictly (runId shape, workflow
// and goal as strings) so we never load a state with the wrong identity,
// but be permissive about the structured fields — fill in safe defaults
// when steps/budget/etc. are missing or wrong-shaped. This preserves
// compatibility with older state.json shapes from prior versions while
// still preventing the crash modes the validator was added to stop.
function normalizeLoadedState(raw: unknown): RunState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["runId"] !== "string" || !isSafeRunId(o["runId"] as string)) return null;
  if (typeof o["workflow"] !== "string") return null;
  if (typeof o["goal"] !== "string") return null;
  // Fill in defaults rather than rejecting — these fields existed in
  // every version but minimal test fixtures and old crashed states may
  // omit them.
  const steps = Array.isArray(o["steps"]) ? o["steps"] : [];
  const budget = (o["budget"] && typeof o["budget"] === "object" && !Array.isArray(o["budget"]))
    ? { ...DEFAULT_BUDGET, ...(o["budget"] as Partial<Budget>) }
    : DEFAULT_BUDGET;
  if (!budget.spent || typeof budget.spent !== "object") {
    budget.spent = { costUsd: 0, wallSeconds: 0, tokens: 0 };
  }
  // ApprovalWatcher Phase 1 round-2 MEDIUM 1: normalize the new optional
  // fields so a state file with `schemaVersion:"1"` (string), `adhocHoldExpiresAt:"garbage"`,
  // or `pauseForUser:null` does NOT slip through as typed but invalid data
  // that Phase-N readers would misuse. Drop on validation miss; consumers
  // see undefined and apply their own defaults.
  const normalized = { ...(o as Record<string, unknown>), steps, budget };
  if (
    "schemaVersion" in normalized &&
    (typeof normalized.schemaVersion !== "number" ||
      !Number.isFinite(normalized.schemaVersion) ||
      (normalized.schemaVersion as number) < 0)
  ) {
    delete normalized.schemaVersion;
  }
  if ("adhocHoldExpiresAt" in normalized) {
    const v = normalized.adhocHoldExpiresAt;
    if (typeof v !== "string" || !Number.isFinite(Date.parse(v as string))) {
      delete normalized.adhocHoldExpiresAt;
    }
  }
  if ("pauseForUser" in normalized) {
    const v = normalized.pauseForUser as unknown;
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      typeof (v as { reason?: unknown }).reason !== "string"
    ) {
      delete normalized.pauseForUser;
    }
  }
  return normalized as RunState;
}

const MAX_STATE_BYTES = 5 * 1024 * 1024; // 5MB hard cap — real states are <100KB

export async function loadRunState(runsDir: string, runId: string): Promise<RunState | null> {
  // Round-2 C1: refuse traversal-shaped runIds. Returning null (vs throwing)
  // matches the existing "missing run" semantic so callers like
  // ADWEngine.resumeRun cleanly surface "Run X not found" without leaking
  // a separate error class.
  if (!isSafeRunId(runId)) return null;
  try {
    const stateFile = join(runsDir, runId, "state.json");
    const raw = await readFile(stateFile, "utf8");
    if (raw.length > MAX_STATE_BYTES) {
      console.error(
        `[pi-engineering] state.json for ${runId} exceeds ${MAX_STATE_BYTES} bytes — refusing to load.`,
      );
      return null;
    }
    const parsed = JSON.parse(raw);
    const normalized = normalizeLoadedState(parsed);
    if (!normalized) {
      console.error(
        `[pi-engineering] state.json for ${runId} failed shape validation (missing/invalid runId, workflow, or goal) — refusing to load.`,
      );
      return null;
    }
    return normalized;
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
