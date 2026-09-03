import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Environment variable that relocates the factory state directory (tests always set it). */
export const FACTORY_HOME_ENV = "PI_SDLC_HOME";

/**
 * A run id is a single safe path segment: no dots, slashes or spaces, max 128 chars,
 * and it must start with an alphanumeric — which also keeps the reserved `_factory`
 * run dir unreachable as a run id. This is the ONLY run-id pattern in the repo;
 * src/engine/state.ts and src/safety/context.ts import it instead of defining their own.
 */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The one per-run subdirectory layout. Engine.startRun creates a run dir via ensureRunDir. */
export const RUN_SUBDIRS = [
  "steps",
  "evidence",
  "approvals/pending",
  "approvals/granted",
  "_verdicts",
  "human-input",
  "checks",
  "scripts",
] as const;

export interface FactoryDirs {
  home: string;
  runs: string;
  factoryRuns: string;
  worktrees: string;
  policy: string;
  bin: string;
}

export interface RunDirs {
  runDir: string;
  steps: string;
  evidence: string;
  approvalsPending: string;
  approvalsGranted: string;
  verdicts: string;
  humanInput: string;
  checks: string;
  scripts: string;
}

/** `~/.pi/sdlc-factory`, or `PI_SDLC_HOME` (made absolute) when set and non-blank. */
export function factoryHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[FACTORY_HOME_ENV];
  if (override !== undefined && override.trim() !== "") return resolve(override);
  return join(homedir(), ".pi", "sdlc-factory");
}

export function runsDir(home: string = factoryHome()): string {
  return join(home, "runs");
}

export function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)} (expected ${RUN_ID_RE.source})`);
  }
}

export function runDir(runId: string, home: string = factoryHome()): string {
  assertRunId(runId);
  return join(runsDir(home), runId);
}

/**
 * First line of every file the factory or a worker generates under a run dir (locked rule).
 * This is the ONLY definition: src/runtime/marker.ts, src/engine/state.ts,
 * src/gate/generated-docs.ts, src/steer/human-input.ts, src/safety/context.ts and
 * src/controller/artifacts.ts import or re-export it rather than retyping the literal.
 */
export function generatedMarker(runId: string): string {
  return `<!-- pi-sdlc-factory generated · run ${runId} · do not commit -->`;
}

export const GENERATED_MARKER_RE = /^<!-- pi-sdlc-factory generated · run [A-Za-z0-9_-]+ · do not commit -->$/;

export async function ensureDirs(home: string = factoryHome()): Promise<FactoryDirs> {
  const dirs: FactoryDirs = {
    home,
    runs: join(home, "runs"),
    factoryRuns: join(home, "runs", "_factory"),
    worktrees: join(home, "worktrees"),
    policy: join(home, "policy"),
    bin: join(home, "bin"),
  };
  for (const d of [dirs.home, dirs.runs, dirs.factoryRuns, dirs.worktrees, dirs.policy, dirs.bin]) {
    await mkdir(d, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

export async function ensureRunDir(runId: string, home: string = factoryHome()): Promise<RunDirs> {
  const base = runDir(runId, home);
  for (const rel of RUN_SUBDIRS) {
    await mkdir(join(base, ...rel.split("/")), { recursive: true, mode: 0o700 });
  }
  return {
    runDir: base,
    steps: join(base, "steps"),
    evidence: join(base, "evidence"),
    approvalsPending: join(base, "approvals", "pending"),
    approvalsGranted: join(base, "approvals", "granted"),
    verdicts: join(base, "_verdicts"),
    humanInput: join(base, "human-input"),
    checks: join(base, "checks"),
    scripts: join(base, "scripts"),
  };
}
