import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { isAbsolute, join } from "path";
import { isSafeRunId } from "./RunState.js";

export type ActiveRunState = {
  runId: string;
  phase: "answering" | "approving";
  stepName: string;
  runsDir: string;
};

const ALLOWED_PHASES: ReadonlySet<ActiveRunState["phase"]> = new Set(["answering", "approving"]);
// stepName flows into the orchestrator's input projection but is otherwise
// loosely typed. Pin it to a safe identifier shape (same alphabet as runId)
// so a tampered file cannot smuggle prompt-injection payloads.
const STEP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function activeRunPath(): string {
  return join(process.cwd(), ".pi", "engineering-team", "active-run.json");
}

// Codex round-4 HIGH: previously readActiveRun cast parsed JSON straight to
// ActiveRunState. Callers (notably src/index.ts answer-input hook) then
// joined state.runsDir + state.runId to write answers.md, so a tampered
// active-run.json could direct the next user-supplied text to any path the
// extension could write to. This validator enforces:
//   - runId matches isSafeRunId (no traversal, no shell-meta)
//   - phase is a known enum value
//   - stepName matches STEP_NAME_RE
//   - runsDir is an absolute path with no parent-traversal segments
//
// The strict isSafeRunId guard (no "..") is the primary defense against
// path-traversal — even with a malicious runsDir, the runId cannot escape
// its parent directory. runsDir is left to absolute-path validation so
// tests and operators can point runs at non-default roots, but a relative
// path is rejected outright (a relative runsDir would otherwise be
// interpreted against cwd, opening a separate attack surface).
function validateActiveRun(raw: unknown): ActiveRunState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const runId = o["runId"];
  const phase = o["phase"];
  const stepName = o["stepName"];
  const runsDir = o["runsDir"];
  if (typeof runId !== "string" || !isSafeRunId(runId)) return null;
  if (typeof phase !== "string" || !ALLOWED_PHASES.has(phase as ActiveRunState["phase"])) return null;
  if (typeof stepName !== "string" || !STEP_NAME_RE.test(stepName)) return null;
  if (typeof runsDir !== "string" || runsDir.length === 0) return null;
  if (!isAbsolute(runsDir)) return null;
  if (runsDir.split("/").includes("..")) return null;
  return {
    runId,
    phase: phase as ActiveRunState["phase"],
    stepName,
    runsDir,
  };
}

export async function writeActiveRun(state: ActiveRunState): Promise<void> {
  // Codex round-4 HIGH defense-in-depth: validate before writing so a buggy
  // caller cannot put an unsafe payload on disk that the next reader would
  // then reject and discard.
  if (!validateActiveRun(state)) {
    throw new Error(
      `writeActiveRun refused: state failed validation (runId/phase/stepName/runsDir).`,
    );
  }
  const dir = join(process.cwd(), ".pi", "engineering-team");
  await mkdir(dir, { recursive: true });
  await writeFile(activeRunPath(), JSON.stringify(state, null, 2));
}

export async function readActiveRun(): Promise<ActiveRunState | null> {
  let raw: string;
  try {
    raw = await readFile(activeRunPath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON — clear the file so the next reader does not loop on it.
    try { await unlink(activeRunPath()); } catch { /* ignore */ }
    return null;
  }
  const validated = validateActiveRun(parsed);
  if (!validated) {
    console.error(
      "[pi-engineering] active-run.json failed validation; clearing. Tampered or shape-mismatched payload was: " +
      JSON.stringify(parsed).slice(0, 200),
    );
    try { await unlink(activeRunPath()); } catch { /* ignore */ }
    return null;
  }
  return validated;
}

export async function clearActiveRun(): Promise<void> {
  try {
    await unlink(activeRunPath());
  } catch {
    // file may not exist — that is fine
  }
}
