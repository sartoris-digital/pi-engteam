import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { GENERATED_MARKER_RE, RUN_ID_RE, RUN_SUBDIRS, generatedMarker } from "../home.js";
import type { RunState } from "./types.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The run-directory layout is defined once in src/home.ts; re-exported for the engine's callers. */
export { RUN_SUBDIRS };

/** 26-char ULID-style id: 10 chars of ms time + 16 random chars, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD.charAt((bytes[i] ?? 0) % 32);
  return time + rand;
}

/** RUN_ID_RE (src/home.ts) is the only run-id pattern; its first char class rejects "_factory". */
export function isSafeRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

/** Explicit-runsDir variant of home.runDir(runId), which resolves under the factory home. */
export function runDirPath(runsDir: string, runId: string): string {
  if (!isSafeRunId(runId)) throw new Error(`unsafe run id: ${JSON.stringify(runId)}`);
  return join(runsDir, runId);
}

export function markerLine(runId: string): string {
  return generatedMarker(runId);
}

export function stripMarker(text: string): string {
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  if (!GENERATED_MARKER_RE.test(first)) return text;
  return nl === -1 ? "" : text.slice(nl + 1);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Write via a sibling tmp file + rename so readers never see a partial file. */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, content, { mode });
  await rename(tmp, path);
}

export async function writeGeneratedFile(path: string, runId: string, body: string, mode = 0o600): Promise<void> {
  await writeFileAtomic(path, `${markerLine(runId)}\n${body}`, mode);
}

export async function readGeneratedFile(path: string): Promise<string | null> {
  try {
    return stripMarker(await readFile(path, "utf8"));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function writeGeneratedJson(path: string, runId: string, value: unknown, mode = 0o600): Promise<void> {
  await writeGeneratedFile(path, runId, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function readGeneratedJson<T>(path: string): Promise<T | null> {
  const text = await readGeneratedFile(path);
  return text === null ? null : (JSON.parse(text) as T);
}

export interface NewRunParams {
  workflow: string;
  lane: string;
  kind: RunState["kind"];
  tier: RunState["tier"];
  currentStep: string;
  ticket: RunState["ticket"];
  workspaceDir: string;
  mainCheckout: string;
  branch: string;
  baseSha: string;
  configSha: string;
  budget: RunState["budget"];
  now?: () => number;
}

export async function newRunState(runsDir: string, params: NewRunParams): Promise<RunState> {
  const now = params.now ?? Date.now;
  const runId = ulid(now());
  const runDir = runDirPath(runsDir, runId);
  // Same tree home.ensureRunDir(runId) creates, rooted at the runsDir the engine was given.
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  for (const sub of RUN_SUBDIRS) await mkdir(join(runDir, ...sub.split("/")), { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(runDir, ".secret"), randomBytes(32).toString("hex"), 0o600);
  const at = new Date(now()).toISOString();
  const state: RunState = {
    runId,
    workflow: params.workflow,
    lane: params.lane,
    kind: params.kind,
    tier: params.tier,
    status: "pending",
    currentStep: params.currentStep,
    iteration: 0,
    rounds: {},
    steps: [],
    artifacts: {},
    ticket: params.ticket,
    workspaceDir: params.workspaceDir,
    mainCheckout: params.mainCheckout,
    branch: params.branch,
    baseSha: params.baseSha,
    hostCommits: [],
    budget: { ...params.budget },
    wallSecondsUsed: 0,
    costUsd: 0,
    configSha: params.configSha,
    nonce: randomBytes(16).toString("hex"),
    startedAt: at,
    updatedAt: at,
  };
  await saveRunState(runsDir, state);
  return state;
}

export async function readRunSecret(runDir: string): Promise<string> {
  return (await readFile(join(runDir, ".secret"), "utf8")).trim();
}

export async function saveRunState(runsDir: string, state: RunState): Promise<void> {
  const runDir = runDirPath(runsDir, state.runId);
  state.updatedAt = new Date().toISOString();
  await writeGeneratedJson(join(runDir, "state.json"), state.runId, state);
}

export async function loadRunState(runsDir: string, runId: string): Promise<RunState | null> {
  if (!isSafeRunId(runId)) return null;
  return readGeneratedJson<RunState>(join(runsDir, runId, "state.json"));
}

export async function listRuns(runsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!isSafeRunId(name)) continue;
    try {
      const s = await stat(join(runsDir, name, "state.json"));
      if (s.isFile()) out.push(name);
    } catch {
      // not a run directory
    }
  }
  return out.sort();
}
