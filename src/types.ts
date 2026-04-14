// src/types.ts
export type TeamMessage = {
  id: string;
  from: string;
  to: string;
  summary: string;
  message: string;
  requestId?: string;
  type?: "request" | "response" | "shutdown_request" | "shutdown_response";
  ts: string;
};

export type RunStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "aborted";

export type Budget = {
  maxIterations: number;
  maxCostUsd: number;
  maxWallSeconds: number;
  maxTokens: number;
  spent: { costUsd: number; wallSeconds: number; tokens: number };
};

export type StepRecord = {
  name: string;
  startedAt?: string;
  endedAt?: string;
  verdict?: Verdict;
  issues?: string[];
  handoffHint?: string;
  artifacts?: string[];
  error?: string;
};

export type ApprovalRecord = {
  tokenId: string;
  op: string;
  expiresAt: string;
  consumed: boolean;
  argsHash: string;
};

export type RunState = {
  runId: string;
  workflow: string;
  goal: string;
  status: RunStatus;
  currentStep: string;
  iteration: number;
  budget: Budget;
  steps: StepRecord[];
  artifacts: Record<string, string>;
  approvals: ApprovalRecord[];
  planMode: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EventCategory =
  | "lifecycle" | "tool_call" | "tool_result" | "message"
  | "verdict" | "budget" | "safety" | "approval" | "error";

export type EngteamEvent = {
  ts: string;
  runId: string;
  step?: string;
  iteration?: number;
  agentId?: string;
  agentName?: string;
  category: EventCategory;
  type: string;
  payload: Record<string, unknown>;
  rawArgsRef?: string;
  summary?: string;
};

export type Verdict = "PASS" | "FAIL" | "NEEDS_MORE";

export type ClassifierResult = {
  classification: "safe" | "destructive" | "blocked";
  rule?: string;
  reason?: string;
};

export type VerdictPayload = {
  step: string;
  verdict: Verdict;
  issues?: string[];
  artifacts?: string[];
  handoffHint?: string;
};

export type SafetyConfig = {
  hardBlockers: { enabled: boolean; alwaysOn: boolean };
  planMode: { defaultOn: boolean };
  classification: { mode: "default-deny"; safeAllowlistExtend: string[]; destructiveOverride: string[] };
  approvalAuthority: "judge";
  exemptPaths: string[];
  tokenTtlSeconds: number;
  allowRunLifetimeScope: boolean;
};

export type ModelRouting = {
  overrides: Record<string, string>;
  budgetDownshift: {
    enabled: boolean;
    triggerAtPercent: number;
    rules: Record<string, string>;
    protected: string[];
  };
};

export type AgentDefinition = {
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
};

export type BudgetStatus = {
  ok: boolean;
  warnings: Array<"iterations" | "cost" | "wall" | "tokens">;
  exhausted: Array<"iterations" | "cost" | "wall" | "tokens">;
};

export type ApprovalToken = {
  tokenId: string;
  runId: string;
  op: string;
  argsHash: string;
  scope: "once" | "run-lifetime";
  expiresAt: string;
  signature: string;
};
