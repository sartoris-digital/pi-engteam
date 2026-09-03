import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeStepPrompt } from "./prompt.js";
import type { WorkerExecutor, WorkerRequest } from "./types.js";

export const ENV_SCRUB_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"] as const;
export const ENV_SCRUB_PREFIXES = ["AZURE_", "JIRA_"] as const;

export interface EnvScrubProbeOptions {
  piBinary: string;
  executor: WorkerExecutor;
  home: string;
}

function isScrubbedKey(key: string): boolean {
  if ((ENV_SCRUB_KEYS as readonly string[]).includes(key)) return true;
  return ENV_SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export async function runEnvScrubProbe(opts: EnvScrubProbeOptions): Promise<{ leaked: string[] }> {
  const runId = "envscrub";
  const runsDir = join(opts.home, "runs");
  const runDir = join(runsDir, runId);
  const cwd = join(opts.home, "ws");
  await mkdir(cwd, { recursive: true });
  const promptPath = await writeStepPrompt(runDir, "implement", "env scrub probe");
  const req: WorkerRequest = {
    runId,
    runDir,
    runsDir,
    stage: "implement",
    round: 1,
    agent: {
      name: "implementer",
      model: "probe",
      promptPath,
      tools: ["read"],
      stageClass: "read-only",
    },
    promptPath,
    cwd,
    projectRoot: opts.home,
    policyFile: join(opts.home, "policy.yaml"),
    policySha: "probe",
    extraUpsert: [],
    denyUpsert: [],
    nonce: "env-scrub",
    timeoutMs: 15_000,
    signal: new AbortController().signal,
    piBinary: opts.piBinary,
  };
  const result = await opts.executor.run(req);
  const keys = result.verdict?.issues ?? [];
  return { leaked: keys.filter(isScrubbedKey) };
}
