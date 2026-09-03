import { AGENTS } from "../lanes/catalog.js";
import {
  DEFAULT_V3_POLICY,
  V3_FLAG_NAMES,
  v3Enabled,
  type V3HostConfig,
  type V3Policy,
} from "./dispatch.js";
import { learnerJustified, maybeLearnerAgent, type LedgerEvent } from "./learner.js";

export type V3DoctorStatus = "pass" | "warn" | "fail";

export interface V3DoctorLine {
  name: string;
  status: V3DoctorStatus;
  detail: string;
}

export interface V3StatusItem {
  value: string;
  label: string;
  description: string;
}

export const V3_EVENT_TYPES = [
  "factory.v3.collaborate-exec.selected",
  "factory.v3.cross-repo.share",
  "factory.v3.cross-repo.import",
  "factory.v3.learner.skip",
  "factory.v3.learner.run",
  "factory.v3.setfit.disagree",
] as const;

export type V3EventType = (typeof V3_EVENT_TYPES)[number];

export function isV3EventType(type: string): boolean {
  return type.startsWith("factory.v3.");
}

export function v3SetupDefaults(): V3Policy {
  return structuredClone(DEFAULT_V3_POLICY);
}

function flagEnabled(cfg: V3HostConfig, flag: (typeof V3_FLAG_NAMES)[number]): boolean {
  return v3Enabled(cfg, flag);
}

export function collectV3DoctorLines(input: {
  cfg: V3HostConfig;
  events?: readonly LedgerEvent[];
  agents?: readonly string[];
  now?: Date;
}): V3DoctorLine[] {
  const events = input.events ?? [];
  const agents = input.agents ?? AGENTS;
  const flagBits = V3_FLAG_NAMES.map((flag) => `${flag}: ${flagEnabled(input.cfg, flag)}`).join(", ");
  const justified = learnerJustified(events, { now: input.now });
  const enabled = flagEnabled(input.cfg, "learner");
  const registered = maybeLearnerAgent(input.cfg, events, { now: input.now }) === "learner" || agents.includes("learner");
  const mergeOn = flagEnabled(input.cfg, "mergeQueue");
  return [
    { name: "v3.flags", status: "pass", detail: flagBits },
    {
      name: "gitlab",
      status: "pass",
      detail: flagEnabled(input.cfg, "gitlab") ? "enabled (probe required)" : "disabled (default)",
    },
    {
      name: "linear",
      status: "pass",
      detail: flagEnabled(input.cfg, "linear") ? "enabled (probe required)" : "disabled (default)",
    },
    {
      name: "mcp",
      status: "pass",
      detail: flagEnabled(input.cfg, "mcpTrackers") ? "enabled (probe required)" : "disabled (default)",
    },
    {
      name: "setfit",
      status: "pass",
      detail: flagEnabled(input.cfg, "setfit") ? "flag on (not dispatching until ready)" : "not dispatching",
    },
    {
      name: "secondReview",
      status: "pass",
      detail: flagEnabled(input.cfg, "secondReview") ? "sampling" : "sampled count 0, disagreement rate 0",
    },
    {
      name: "transcriptAudit",
      status: "pass",
      detail: flagEnabled(input.cfg, "transcriptAudit") ? "escalating on findings" : "not escalating",
    },
    {
      name: "mergeQueue",
      status: "pass",
      detail: mergeOn ? "enabled (enqueue auto-merge only)" : "off (factory never merges)",
    },
    {
      name: "learner",
      status: registered ? "warn" : "pass",
      detail: `justified: ${justified.ok}, enabled: ${enabled}, registered: ${registered}`,
    },
  ];
}

export function formatV3DoctorReport(lines: V3DoctorLine[]): string {
  return ["# v3 doctor", ...lines.map((line) => `- ${line.name}: ${line.status} — ${line.detail}`)].join("\n");
}

export function v3StatusCompletions(): V3StatusItem[] {
  return [
    { value: "setfit status", label: "setfit", description: "SetFit label counts and dispatch readiness (read-only)" },
    { value: "learner status", label: "learner", description: "learner ledger gate and registration (read-only)" },
  ];
}

export function formatV3Status(verb: "setfit" | "learner", input: { cfg: V3HostConfig; events?: readonly LedgerEvent[] }): string {
  const lines = collectV3DoctorLines({ cfg: input.cfg, events: input.events ?? [] });
  const name = verb === "setfit" ? "setfit" : "learner";
  const line = lines.find((item) => item.name === name);
  return line ? `${line.name}: ${line.detail}` : `${verb}: unknown`;
}
