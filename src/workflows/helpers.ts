import { isAbsolute, join, basename } from "path";
import type { StepContext } from "./types.js";

/**
 * Provider-compat: resolve a claimed artifact name (from a verdict's
 * `artifacts[i]` field) to an absolute path under the run directory.
 *
 * Workflow prompts ask agents to write files like `triage-summary.md`,
 * `fix-plan.md`, etc. Under Anthropic-direct + CoPilot routing alike,
 * the orchestrator's synthesis layer (TeamRuntime artifact-validation
 * block) lands the file at `<runDir>/<basename>` and rewrites the
 * verdict's artifact entry to the safe basename. Downstream steps
 * historically stored that basename in `ctx.run.artifacts` and
 * embedded it verbatim into the next agent's prompt — but the next
 * agent's `read` tool resolved that basename relative to cwd, not
 * runDir, and missed the file.
 *
 * resolveArtifactPath normalizes the claim to an absolute path under
 * runDir so downstream prompts can embed a path that any agent can
 * actually open.
 *
 * Rules:
 * - Absolute paths pass through unchanged (caller is responsible for
 *   trusting them).
 * - Relative paths have their basename joined to `<runsDir>/<runId>`.
 * - If both the claimed artifact and a fallback are missing, returns
 *   the absolute fallback path under runDir.
 */
export function resolveArtifactPath(
  ctx: StepContext,
  claimed: string | undefined,
  fallback: string,
): string {
  const raw = claimed ?? fallback;
  if (isAbsolute(raw)) return raw;
  return join(ctx.engine.getRunsDir(), ctx.run.runId, basename(raw));
}
