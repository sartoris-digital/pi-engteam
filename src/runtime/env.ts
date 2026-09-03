import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRequest } from "./types.js";

/** Process basics copied from the host env (spec §5.8 / §7.6: env -i plus an allowlist). */
export const WORKER_ENV_PASSTHROUGH = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR"] as const;
/** Model-provider keys a worker may inherit. The operator's providerKeyEnv narrows this in v1. */
export const DEFAULT_PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"] as const;
export const WORKER_ENV_PREFIX = "PI_SDLC_";
/** The only extraEnv keys a caller may set. Everything else, including locked PI_SDLC_*, is refused. */
export const EXTRA_ENV_ALLOWLIST = new Set(["PI_SDLC_STUB_SCENARIO", "PI_SDLC_STUB_LOG"]);
const EXTRA_ENV_LOCKED = new Set([
  "PI_SDLC_AGENT_MODE",
  "PI_SDLC_VERDICT_FILE",
  "PI_SDLC_WORKSPACE_DIR",
  "PI_SDLC_NONCE",
  "PI_SDLC_TOOLS",
]);

export interface ScrubDirs {
  root: string;
  /** Empty directory exported as GH_CONFIG_DIR. */
  ghConfigDir: string;
  /** Empty file exported as GIT_CONFIG_GLOBAL. */
  gitConfigGlobal: string;
}

export function createScrubDirs(parent: string = tmpdir()): ScrubDirs {
  const root = mkdtempSync(join(parent, "pi-sdlc-scrub-"));
  const ghConfigDir = join(root, "gh");
  mkdirSync(ghConfigDir, { mode: 0o700 });
  const gitConfigGlobal = join(root, "gitconfig");
  writeFileSync(gitConfigGlobal, "", { mode: 0o600 });
  return { root, ghConfigDir, gitConfigGlobal };
}

/** The worker's pre-created verdict slot (contract §7.1: the one `_verdicts/` path a worker may write). */
export function verdictFilePath(runDir: string, stage: string, round: number): string {
  return join(runDir, "_verdicts", `${stage}-r${round}.json`);
}

export interface BuildWorkerEnvOptions {
  providerKeys?: readonly string[];
  scrub?: ScrubDirs;
  /** Additional PI_SDLC_* variables (tests: PI_SDLC_STUB_SCENARIO). Any other prefix throws. */
  extra?: Record<string, string>;
}

export function buildWorkerEnv(
  base: NodeJS.ProcessEnv,
  req: WorkerRequest,
  opts: BuildWorkerEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...WORKER_ENV_PASSTHROUGH, ...(opts.providerKeys ?? DEFAULT_PROVIDER_KEYS)]) {
    const value = base[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  const scrub = opts.scrub ?? createScrubDirs();
  Object.assign(env, {
    PI_SDLC_AGENT_MODE: "1",
    PI_SDLC_RUN_ID: req.runId,
    PI_SDLC_RUNS_DIR: req.runsDir,
    PI_SDLC_STEP: req.stage,
    PI_SDLC_AGENT: req.agent.name,
    PI_SDLC_VERDICT_FILE: verdictFilePath(req.runDir, req.stage, req.round),
    PI_SDLC_WORKSPACE_DIR: req.cwd,
    PI_SDLC_PROJECT_ROOT: req.projectRoot,
    PI_SDLC_POLICY_FILE: req.policyFile,
    PI_SDLC_POLICY_SHA: req.policySha,
    // Canonical encoding: JSON string arrays; src/safety/context.ts parses them with JSON.parse.
    PI_SDLC_EXTRA_UPSERT: JSON.stringify(req.extraUpsert),
    PI_SDLC_DENY_UPSERT: JSON.stringify(req.denyUpsert),
    PI_SDLC_NONCE: req.nonce,
    PI_SDLC_TOOLS: (req.tools ?? req.agent.tools).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0).join(","),
    GIT_CONFIG_GLOBAL: scrub.gitConfigGlobal,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o IdentitiesOnly=yes -i /nonexistent",
    GH_CONFIG_DIR: scrub.ghConfigDir,
    NPM_CONFIG_USERCONFIG: "/dev/null",
  });
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (!key.startsWith(WORKER_ENV_PREFIX)) {
      throw new Error(`buildWorkerEnv: extra key ${key} must start with ${WORKER_ENV_PREFIX}`);
    }
    if (EXTRA_ENV_LOCKED.has(key) || key.startsWith("PI_SDLC_POLICY_")) {
      throw new Error(`buildWorkerEnv: extra key ${key} cannot override a locked PI_SDLC_* variable`);
    }
    if (!EXTRA_ENV_ALLOWLIST.has(key)) {
      throw new Error(`buildWorkerEnv: extra key ${key} is not allowlisted`);
    }
    env[key] = value;
  }
  return env;
}
