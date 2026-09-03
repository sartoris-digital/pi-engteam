import type { CodifyConfig } from "../config/schema.js";
import type { EvidenceRecord } from "../engine/types.js";
import type { LandedAs } from "../git/reconcile.js";

export type { CodifyConfig, EvidenceRecord, LandedAs };

/** Vault reference form used by seeds and manifests. */
export type SecretName = `secret:${string}`;

export type ToolClass = "stage-tool" | "task-tool" | "verifier-script" | "rule-predicate";

export type CodifyTrigger =
  | "post-landed"
  | "schedule"
  | "on-demand"
  | "script-seed"
  | "verifier-gaps"
  | "rule-check";

export type CodifyEligibility = "landed" | "published";

export type MechanicalShape =
  | "version-bump"
  | "dependency-companion"
  | "changelog-entry"
  | "codegen-docs"
  | "boilerplate-from-sibling"
  | "migration-scaffold"
  | "rename"
  | "config-toggle"
  | "header-insertion"
  | "formatting-only";

export type RegistryState =
  | "staged"
  | "probationary"
  | "active"
  | "assist"
  | "demoted"
  | "retired"
  | "rejected"
  | "drifted";

export interface FeatureVector {
  reproducibleByCommand: number;
  diffIsSubstitution: number;
  literalsSourced: number;
  zeroFixRounds: number;
  lowModelEffort: number;
  planImperative: number;
  small: number;
}

export interface DiffFile {
  path: string;
  op: "A" | "M" | "D";
  hunkLines: number;
}

export interface StageDiff {
  files: DiffFile[];
  literals: string[];
  sourced: string[];
}

export interface LandedRecord {
  runId: string;
  landedAs: LandedAs;
  landedSha: string;
  patchIds: string[];
  changedFiles: string[];
  survival: { reverted: boolean; retouched: boolean; linkedBug: boolean };
}

export interface StageExecution {
  runId: string;
  repo: string;
  stage: string;
  mode?: string;
  kind: string;
  lane: string;
  tier: "low" | "elevated";
  headSha: string;
  parentSha: string;
  commands: { argv: string[] }[];
  toolCallCount: number;
  fixRounds: number;
  changedFiles: string[];
  diff: StageDiff;
  title: string;
  briefLiterals: string[];
  planLiterals: string[];
  flags: {
    synthesized: boolean;
    humanIntervened: boolean;
    escalated: boolean;
    tampered: boolean;
    conflict: boolean;
    revise: boolean;
  };
  touches: { security: boolean; risk: boolean; exclusive: boolean };
  /** Optional override used by tests; otherwise derived from the execution. */
  features?: FeatureVector;
  /** Set when the inbox row is published but not yet stamped landed. */
  publishedOnly?: boolean;
  landed?: LandedRecord;
}

export interface CandidateMember {
  runId: string;
  score: number;
  weight?: number;
  landedAs?: LandedAs;
  survival?: LandedRecord["survival"];
}

export interface Cluster {
  signature: string;
  stage: string;
  kind: string;
  lane: string;
  members: CandidateMember[];
  executions: StageExecution[];
  preScore: number;
  shape: MechanicalShape | null;
}

export interface Candidate {
  id: string;
  signature: string;
  stage: string;
  kind: string;
  lane: string;
  classHint: "stage-tool";
  members: CandidateMember[];
  preScore: number;
  shape: MechanicalShape | null;
  trigger: CodifyTrigger;
  probationaryOnly?: boolean;
}

export type AssessmentVerdict = "codifiable" | "assist-only" | "not-codifiable";
export type InputType = "semver" | "identifier" | "relpath-in-globs" | "enum" | "shortText";
export type OracleKind = "fs" | "regex" | "exit-code" | "input";

export interface AssessmentInput {
  name: string;
  type: InputType;
  provenance: string;
  description?: string;
}

export interface AssessmentDecision {
  id: string;
  oracle: OracleKind;
  file?: string;
  pattern?: string;
  branches: string[];
}

export interface Assessment {
  verdict: AssessmentVerdict;
  inputs: AssessmentInput[];
  decisions: AssessmentDecision[];
  postconditions: string[];
  sideEffects: { writeGlobs: string[]; readGlobs: string[] };
  allowedCommands: string[];
  irreversible: boolean;
  residuals: string[];
}

export interface ManifestMatcher {
  titlePatterns: string[];
  planStepPatterns: string[];
  pathGlobs: string[];
}

export interface Manifest {
  name: string;
  version: number;
  class: ToolClass;
  scope: "repo" | "global";
  stage: string;
  kind: string;
  signature: string;
  purpose: string;
  whenNot: string[];
  inputs: AssessmentInput[];
  matcher: ManifestMatcher;
  decisions: AssessmentDecision[];
  postconditions: string[];
  sideEffects: {
    writeGlobs: string[];
    readGlobs: string[];
    allowedCommands: string[];
    writesWorkspace: boolean;
  };
  network?: { allow: string[] };
  secrets: SecretName[];
  wraps?: string;
  commitMessageTemplate?: string;
  checks: string[];
  provenance: { sourceRuns: string[]; seed?: string };
  metadata: {
    "pi-sdlc-factory-codified": true;
    toolSha256: string;
    manifestSha256: string;
    skillSha256: string;
  };
}

export interface RegistryRejectedEntry {
  residuals?: string[];
  until?: string;
  rejectedAt?: string;
}

export type RegistryRejected = Record<string, RegistryRejectedEntry>;

export interface RegistryEntry {
  version: number;
  class: ToolClass;
  scope: "repo" | "global";
  repo?: string;
  state: RegistryState;
  toolSha256: string;
  manifestSha256: string;
  skillSha256: string;
  judgedSha?: string;
  signature: string;
  validation?: { baseSha: string; uvVersion?: string; formatterVersion?: string };
  approver?: { user: string; nonceAt: string };
  secretsBound: boolean;
  stats: {
    exact: number;
    partial: number;
    shadowAgree: number;
    shadowDisagree: number;
    preconditionRefusals: number;
    failures: number;
    recentHits: string[];
    savedUsd: number;
    savedWallSeconds: number;
    lastHitAt?: string;
  };
  history: Array<{ at: string; from: RegistryState | ""; to: RegistryState; by: string; reason: string }>;
}

export interface Registry {
  entries: Record<string, RegistryEntry>;
  rejected: RegistryRejected;
}

export interface Seed {
  runId: string;
  stage: string;
  n: number;
  trigger: "script-seed";
  scriptPath: string;
  commandLines: { argv: string[]; exitCode: number }[];
  filesRead: string[];
  envNames: string[];
  effect: { diff?: string; outputTail?: string };
  taskContextFenced: string;
  placeholders: SecretName[];
  wraps?: string;
}

export type VerifyEvidenceFn = (
  runDir: string,
  stage: string,
  round: number,
  secret: string,
) => Promise<{ ok: boolean; record: EvidenceRecord | null; reason?: string }>;
