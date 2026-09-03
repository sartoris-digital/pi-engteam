import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Verdict } from "../engine/types.js";

export const VERDICT_VALUES = ["PASS", "FAIL", "NEEDS_MORE"] as const;
/** Hard cap on a verdict file / VerdictEmit payload (bytes of UTF-8 JSON). */
export const VERDICT_MAX_BYTES = 256 * 1024;

export interface AgentDef {
  name: string;
  model: string;
  promptPath: string;
  tools: string[];
  stageClass: "read-only" | "writer";
}

export type EgressMode = "off" | "best-effort" | "required";

export interface WorkerEgress {
  mode: EgressMode;
  proxyUrl?: string;
  extraHosts?: string[];
}

export interface WorkerRequest {
  runId: string;
  runDir: string;
  runsDir: string;
  stage: string;
  round: number;
  agent: AgentDef;
  promptPath: string;
  cwd: string;
  projectRoot: string;
  policyFile: string;
  policySha: string;
  extraUpsert: string[];
  denyUpsert: string[];
  nonce: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Executable to spawn; default "pi", tests point at tests/helpers/stub-pi.mjs. */
  piBinary: string;
  /** Tool allowlist copied into PI_SDLC_TOOLS; defaults to agent.tools when omitted. */
  tools?: string[];
  /** Host-injected egress; absent means off (chore-lane default). */
  egress?: WorkerEgress;
}

export interface WorkerResult {
  verdict: VerdictPayload | null;
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
  durationMs: number;
}

export interface VerdictPayload {
  step: string;
  verdict: Verdict;
  issues?: string[];
  artifacts?: string[];
  commit_message?: string;
  changedFiles?: string[];
  dependenciesRequested?: string[];
  testChanges?: string[];
  outOfScope?: string[];
  questions?: string[];
  flags?: string[];
  learnings?: string[];
  scripts?: { path: string; purpose: string; inputsObserved: string[] }[];
}

export interface WorkerExecutor {
  run(req: WorkerRequest): Promise<WorkerResult>;
}

const stringList = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));

/** typebox schema for VerdictPayload; also the parameter schema of the worker's VerdictEmit tool. */
export const VerdictPayloadSchema = Type.Object({
  step: Type.String({ minLength: 1, description: "Stage name this verdict belongs to (must equal PI_SDLC_STEP)" }),
  verdict: StringEnum(VERDICT_VALUES, { description: "PASS, FAIL or NEEDS_MORE" }),
  issues: stringList("Problems found or reasons for FAIL / NEEDS_MORE"),
  artifacts: stringList("Absolute paths of artifacts this step produced"),
  commit_message: Type.Optional(Type.String({ description: "Conventional Commit subject for the host checkpoint commit" })),
  changedFiles: stringList("Workspace-relative files this step changed"),
  dependenciesRequested: stringList("Packages this step needs the host to install"),
  testChanges: stringList("Test files this step changed, declared for the manifest predicate"),
  outOfScope: stringList("Paths that were needed but are outside the allowed roots"),
  questions: stringList("Questions for the operator"),
  flags: stringList("Signals such as approval-needed or tests-wrong"),
  learnings: stringList("Short notes worth keeping for later stages"),
  scripts: Type.Optional(
    Type.Array(
      Type.Object(
        {
          path: Type.String(),
          purpose: Type.String(),
          inputsObserved: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  ),
});

export type VerdictPayloadStatic = Static<typeof VerdictPayloadSchema>;
