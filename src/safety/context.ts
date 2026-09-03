import { join } from "node:path";
import { RUN_ID_RE, generatedMarker } from "../home.js";

/** The generated-artifact marker has one definition, in src/home.ts (Task 0.2). */
export { generatedMarker };

export interface RunContext {
  runId: string;
  runsDir: string;
  runDir: string;
  stage: string;
  agent: string;
  workspaceDir: string;
  projectRoot: string;
  policyFile: string;
  policySha: string;
  extraUpsert: string[];
  denyUpsert: string[];
  nonce: string;
}

export type Block = { block: true; reason: string; terminate?: boolean; layer: "A" | "B" | "C" | "D" };

export class RunContextError extends Error {
  readonly code: "run-id" | "root-list";
  constructor(code: "run-id" | "root-list", message: string) {
    super(message);
    this.name = "RunContextError";
    this.code = code;
  }
}

const REQUIRED_KEYS = [
  "PI_SDLC_RUN_ID",
  "PI_SDLC_RUNS_DIR",
  "PI_SDLC_STEP",
  "PI_SDLC_AGENT",
  "PI_SDLC_WORKSPACE_DIR",
  "PI_SDLC_PROJECT_ROOT",
  "PI_SDLC_POLICY_FILE",
  "PI_SDLC_POLICY_SHA",
  "PI_SDLC_NONCE",
] as const;

export function joinRootList(roots: string[]): string {
  return JSON.stringify(roots);
}

function parseRootListValue(raw: string | undefined): string[] | "invalid" | "empty" {
  if (raw === undefined || raw.trim() === "") return "empty";
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch {
    /* fall through */
  }
  return "invalid";
}

/** JSON helper: empty/invalid → []. Group 4 round-trips worker env through this. */
export function parseRootList(raw: string | undefined): string[] {
  const parsed = parseRootListValue(raw);
  return parsed === "invalid" || parsed === "empty" ? [] : parsed;
}

function required(env: NodeJS.ProcessEnv, key: (typeof REQUIRED_KEYS)[number]): string | null {
  const value = env[key];
  if (value === undefined || value.trim() === "") return null;
  return value;
}

function parseRootListStrict(raw: string | undefined, key: string): string[] {
  const parsed = parseRootListValue(raw);
  if (parsed === "empty") return [];
  if (parsed === "invalid") {
    throw new RunContextError("root-list", `${key} is not a JSON array of strings`);
  }
  return parsed;
}

export function runContextFromEnv(env: NodeJS.ProcessEnv): RunContext | null {
  const values: string[] = [];
  for (const key of REQUIRED_KEYS) {
    const value = required(env, key);
    if (value === null) return null;
    values.push(value);
  }
  const [runId, runsDir, stage, agent, workspaceDir, projectRoot, policyFile, policySha, nonce] = values as [
    string, string, string, string, string, string, string, string, string,
  ];
  if (!RUN_ID_RE.test(runId)) {
    throw new RunContextError("run-id", `invalid runId: ${JSON.stringify(runId)}`);
  }
  return {
    runId,
    runsDir,
    runDir: join(runsDir, runId),
    stage,
    agent,
    workspaceDir,
    projectRoot,
    policyFile,
    policySha,
    extraUpsert: parseRootListStrict(env.PI_SDLC_EXTRA_UPSERT, "PI_SDLC_EXTRA_UPSERT"),
    denyUpsert: parseRootListStrict(env.PI_SDLC_DENY_UPSERT, "PI_SDLC_DENY_UPSERT"),
    nonce,
  };
}
