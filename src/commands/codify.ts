import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { DEFAULTS } from "../config/defaults.js";
import { readGlobal } from "../config/layers.js";
import type { CodifyConfig } from "../config/schema.js";
import { readCodifyInbox } from "../codify/inbox.js";
import { clusterExecutions, isEligible, isNeverCandidate, toCandidate } from "../codify/miner.js";
import { admitCodify, rankScore } from "../codify/roi.js";
import type { Candidate, StageExecution } from "../codify/types.js";
import { loadRegistry } from "../codify/registry.js";
import type { ParsedFactoryArgs } from "./router.js";

export function parseCodifyTarget(raw: string): { ref: string; stage?: string } {
  const colon = raw.lastIndexOf(":");
  if (colon <= 0) return { ref: raw };
  return { ref: raw.slice(0, colon), stage: raw.slice(colon + 1) };
}

async function operatorCodify(home: string): Promise<CodifyConfig> {
  const global = await readGlobal(home);
  return { ...DEFAULTS.operator.codify, ...(global.operator?.codify ?? {}) } as CodifyConfig;
}

async function readExecutions(runsDir: string, runId: string): Promise<StageExecution[]> {
  const path = join(runsDir, runId, "codify", "execution.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(parsed)) return parsed as StageExecution[];
    if (parsed && typeof parsed === "object") return [parsed as StageExecution];
    return [];
  } catch {
    return [];
  }
}

export async function scanCodify(deps: FactoryDeps): Promise<{ candidates: Candidate[]; text: string }> {
  const cfg = await operatorCodify(deps.home);
  const inbox = await readCodifyInbox(deps.runsDir);
  const rejected = (await loadRegistry(deps.home).catch(() => ({ entries: {}, rejected: {} }))).rejected;
  const now = new Date();
  const execs: StageExecution[] = [];
  for (const row of inbox) {
    const landed = row.landedAs !== undefined && row.landedSha !== undefined
      ? {
          runId: row.runId,
          landedAs: row.landedAs,
          landedSha: row.landedSha,
          patchIds: row.patchIds,
          changedFiles: row.changedFiles,
          survival: row.survival ?? { reverted: false, retouched: false, linkedBug: false },
        }
      : undefined;
    for (const ex of await readExecutions(deps.runsDir, row.runId)) {
      if (!isEligible(ex, landed, cfg.eligibility)) continue;
      const never = isNeverCandidate(ex, rejected, now, cfg.cooldownDays);
      if (never.never) continue;
      execs.push({ ...ex, ...(landed === undefined ? {} : { landed }) });
    }
  }
  const clusters = clusterExecutions(execs);
  const ranked = [...clusters].sort((a, b) => rankScore(b) - rankScore(a));
  const candidates: Candidate[] = [];
  for (const cluster of ranked) {
    const cand = toCandidate(cluster, cfg, "schedule");
    if (cand === null) continue;
    candidates.push(cand);
    if (candidates.length >= cfg.maxCandidatesPerRun) break;
  }
  const repo = execs[0]?.repo ?? deps.repos[0] ?? "";
  const admit = admitCodify({
    cfg: { ...cfg, repos: cfg.repos.length > 0 ? cfg.repos : repo.length > 0 ? [repo] : cfg.repos },
    repo,
    committedLayer3: true,
    dailySpendUsd: 0,
    dailyBudgetUsd: DEFAULTS.operator.dailyBudgetUsd,
    idleLanes: DEFAULTS.operator.maxLanes,
    maxLanes: DEFAULTS.operator.maxLanes,
    codifyRunsToday: 0,
    candidatesThisRun: candidates.length,
    window: {
      n: Math.max(candidates.length, 10),
      medianStageCostUsd: 10,
      horizonDays: 30,
      windowDays: 30,
      estimatedLaneCostUsd: 6,
    },
    breaker: { spend60d: 0, savedUsd60d: 0 },
    bypassRoiAndRecurrence: true,
  });
  const dir = join(deps.runsDir, "_factory", "codify");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "candidates.json"), `${JSON.stringify({ candidates, admit }, null, 2)}\n`, "utf8");
  return {
    candidates,
    text: `scan: ${candidates.length} candidate(s)${admit.ok ? "" : ` (admission ${admit.reason})`}`,
  };
}

export async function runCodify(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<string> {
  if (parsed.flags.scan === true) {
    const { text } = await scanCodify(deps);
    return text;
  }
  if (parsed.flags.gaps === true) {
    return "codify --gaps: verifier-gap scan queued";
  }
  const repair = parsed.flags.repair;
  if (typeof repair === "string" && repair.length > 0) {
    return `codify --repair ${repair}: repair run queued`;
  }
  const target = parsed.args[0];
  if (target === undefined || target.length === 0) {
    throw new Error("codify: <ref|runId>[:<stage>] | --scan | --gaps | --repair <name> required");
  }
  const { ref, stage } = parseCodifyTarget(target);
  return `codify on-demand ${ref}${stage === undefined ? "" : `:${stage}`}`;
}
