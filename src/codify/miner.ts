import type { CodifyConfig } from "../config/schema.js";
import { detectMechanicalShape, featuresOf, scoreFeatures } from "./shapes.js";
import { stageSignature } from "./signature.js";
import type {
  Candidate,
  Cluster,
  CodifyEligibility,
  CodifyTrigger,
  LandedRecord,
  RegistryRejected,
  StageExecution,
  VerifyEvidenceFn,
} from "./types.js";

const NEVER_STAGES = new Set(["steer", "review", "security", "judge", "gate", "diagnose", "design"]);
const FLAG_REASONS = [
  "synthesized",
  "humanIntervened",
  "escalated",
  "tampered",
  "conflict",
  "revise",
] as const;
const TOUCH_REASONS: Array<{ key: keyof StageExecution["touches"]; reason: string }> = [
  { key: "security", reason: "securityPaths" },
  { key: "risk", reason: "riskPaths" },
  { key: "exclusive", reason: "exclusivePaths" },
];

export interface EvidenceItem {
  execution: StageExecution;
  runDir: string;
  round: number;
  secret: string;
}

function cooldownActive(entry: RegistryRejected[string], now: Date, cooldownDays: number): boolean {
  if (entry.until !== undefined) {
    const until = Date.parse(entry.until);
    if (!Number.isNaN(until) && now.getTime() < until) return true;
  }
  if (entry.rejectedAt !== undefined) {
    const start = Date.parse(entry.rejectedAt);
    if (Number.isNaN(start)) return false;
    return now.getTime() < start + cooldownDays * 86_400_000;
  }
  return entry.until === undefined && entry.rejectedAt === undefined;
}

export function isNeverCandidate(
  ex: StageExecution,
  rejected: RegistryRejected,
  now: Date,
  cooldownDays: number,
): { never: boolean; reason?: string } {
  if (NEVER_STAGES.has(ex.stage)) return { never: true, reason: ex.stage };
  if (ex.stage === "plan" && ex.mode !== "approach") return { never: true, reason: "plan" };
  if (ex.mode === "conflict" || ex.mode === "revise") return { never: true, reason: ex.mode };
  for (const flag of FLAG_REASONS) {
    if (ex.flags[flag]) return { never: true, reason: flag };
  }
  for (const { key, reason } of TOUCH_REASONS) {
    if (ex.touches[key]) return { never: true, reason };
  }
  const sig = stageSignature(ex);
  const entry = rejected[sig];
  if (entry !== undefined && cooldownActive(entry, now, cooldownDays)) {
    return { never: true, reason: "rejected" };
  }
  return { never: false };
}

export function isEligible(
  ex: StageExecution,
  landed: LandedRecord | undefined,
  eligibility: CodifyEligibility,
): boolean {
  if (landed !== undefined) return true;
  return eligibility === "published";
}

function memberOf(ex: StageExecution): Cluster["members"][number] {
  return {
    runId: ex.runId,
    score: scoreFeatures(featuresOf(ex)),
    ...(ex.publishedOnly === true ? { weight: 0.5 } : {}),
    ...(ex.landed?.landedAs !== undefined ? { landedAs: ex.landed.landedAs } : {}),
    ...(ex.landed?.survival !== undefined ? { survival: ex.landed.survival } : {}),
  };
}

export function clusterExecutions(execs: StageExecution[]): Cluster[] {
  const groups = new Map<string, StageExecution[]>();
  for (const ex of execs) {
    const key = stageSignature(ex);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [ex]);
    else list.push(ex);
  }
  const clusters: Cluster[] = [];
  for (const [signature, executions] of groups) {
    const members = executions.map(memberOf);
    const preScore = members.reduce((s, m) => s + m.score, 0) / members.length;
    const head = executions[0]!;
    clusters.push({
      signature,
      stage: head.stage,
      kind: head.kind,
      lane: head.lane,
      members,
      executions,
      preScore,
      shape: detectMechanicalShape(head),
    });
  }
  return clusters;
}

export function toCandidate(
  cluster: Cluster,
  cfg: CodifyConfig,
  trigger: CodifyTrigger = "post-landed",
): Candidate | null {
  const n = cluster.members.length;
  const minN = cfg.minRecurrence;
  const shapeHit = cluster.shape !== null;
  const n1Elevated = n === 1 && cluster.executions.some((e) => e.tier === "elevated");
  if (n1Elevated) return null;
  const recurrent = n >= minN && cluster.preScore >= 0.5;
  const singleShot = n === 1 && cluster.preScore >= 0.7 && shapeHit;
  if (!recurrent && !singleShot) return null;
  const probationaryOnly = cluster.members.some((m) => m.weight === 0.5) || cluster.executions.some((e) => e.publishedOnly === true);
  return {
    id: cluster.signature,
    signature: cluster.signature,
    stage: cluster.stage,
    kind: cluster.kind,
    lane: cluster.lane,
    classHint: "stage-tool",
    members: cluster.members,
    preScore: cluster.preScore,
    shape: cluster.shape,
    trigger,
    ...(probationaryOnly ? { probationaryOnly: true } : {}),
  };
}

export async function verifiedExecutions(items: EvidenceItem[], verifyEvidence: VerifyEvidenceFn): Promise<StageExecution[]> {
  const out: StageExecution[] = [];
  for (const item of items) {
    const result = await verifyEvidence(item.runDir, item.execution.stage, item.round, item.secret);
    if (result.ok && result.record !== null) out.push(item.execution);
  }
  return out;
}
