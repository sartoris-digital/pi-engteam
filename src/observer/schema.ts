export type { EngteamEvent, EventCategory } from "../types.js";
import {
  APPROVAL_EVENT_TYPES_REQUEST_SCOPED,
  APPROVAL_EVENT_TYPES_GLOBAL,
} from "../types.js";

// PLAN.md ApprovalWatcher Phase 1 (implementation step 0): the `approval`
// category's type list is derived from the single source of truth in
// src/types.ts. This keeps the two constant lists in sync — when a new
// approval event type is added there, every consumer of EVENT_TYPES sees
// it without a parallel edit. Covers both request-scoped events
// (dispatch, deny, ...) and global / run-scoped events
// (lease_skipped, dispatch_skipped_capacity, alert, config_reload_failed).
const APPROVAL_EVENT_TYPES: readonly string[] = [
  ...APPROVAL_EVENT_TYPES_REQUEST_SCOPED,
  ...APPROVAL_EVENT_TYPES_GLOBAL,
];

export const EVENT_TYPES = {
  lifecycle: ["run.start", "run.end", "step.start", "step.end", "agent.start", "agent.end", "team.boot", "team.shutdown"],
  tool_call: ["start", "end"],
  tool_result: ["ok", "error"],
  message: ["sent", "received", "broadcast"],
  verdict: ["emit"],
  budget: ["tick", "warn_75", "warn_90", "exhausted", "extended", "rate_warn", "rate_pause"],
  safety: ["block", "warn", "plan_mode_on", "plan_mode_off", "secret_access", "secret_skip", "secret_scrub", "verifier_script_updated", "domain_block", "domain_warn"],
  approval: APPROVAL_EVENT_TYPES,
  error: ["uncaught", "agent_crash", "router_drop", "sink_failure"],
} as const;
