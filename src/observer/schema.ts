export type { EngteamEvent, EventCategory } from "../types.js";

export const EVENT_TYPES = {
  lifecycle: ["run.start", "run.end", "step.start", "step.end", "agent.start", "agent.end", "team.boot", "team.shutdown"],
  tool_call: ["start", "end"],
  tool_result: ["ok", "error"],
  message: ["sent", "received", "broadcast"],
  verdict: ["emit"],
  budget: ["tick", "warn_75", "warn_90", "exhausted", "extended"],
  safety: ["block", "warn", "plan_mode_on", "plan_mode_off"],
  approval: ["request", "grant", "consume", "revoke", "expired"],
  error: ["uncaught", "agent_crash", "router_drop", "sink_failure"],
} as const;
