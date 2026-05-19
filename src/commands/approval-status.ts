// src/commands/approval-status.ts
//
// PLAN.md ApprovalWatcher Phase 2 — read-only diagnostic command.
// Prints the resolved approval-watcher config + (in Phase 9) per-run
// metrics. Phase 2 only surfaces the config + canary mode resolution
// so operators can verify their safety.json changes landed correctly.
//
// IMPORTANT: this command does NOT write to disk and does NOT bump
// liveness — it is purely passive (PLAN.md round-A3 HIGH 1).

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSafetyConfig } from "../config.js";
import type { ApprovalWatcherConfig } from "../types.js";

function resolveCanaryMode(c: ApprovalWatcherConfig): string {
  if (!c.enabled) return "disabled";
  if (c.allRuns) return "all-runs";
  if (c.canaryRunIds.length === 0) return "canary-empty (no active runs)";
  return `canary (${c.canaryRunIds.length} run${c.canaryRunIds.length === 1 ? "" : "s"})`;
}

export function registerApprovalStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("approval-status", {
    description:
      "Show the current ApprovalWatcher configuration and (in future phases) per-run metrics. Usage: /approval-status [runId]",
    handler: async (raw, ctx) => {
      const args = raw.trim();
      const runIdArg = args.length > 0 ? args : undefined;

      try {
        const safety = await loadSafetyConfig();
        const w = safety.approvalWatcher!;
        const lines: string[] = [];
        lines.push("ApprovalWatcher status:");
        lines.push(`  enabled:               ${w.enabled}`);
        lines.push(`  mode:                  ${w.mode ?? "dormant"}`);
        lines.push(`  resolved canary mode:  ${resolveCanaryMode(w)}`);
        lines.push(`  dispatchPaused:        ${w.dispatchPaused}`);
        lines.push(`  emergencyStop:         ${w.emergencyStop}`);
        lines.push(`  pauseEpoch:            ${w.pauseEpoch}`);
        lines.push(`  canaryRunIds:          [${w.canaryRunIds.join(", ")}]`);
        lines.push(`  allRuns:               ${w.allRuns}`);
        lines.push(`  maxRequestAgeSeconds:  ${w.maxRequestAgeSeconds}`);
        if (runIdArg) {
          lines.push("");
          lines.push(`Run-scoped diagnostics for ${runIdArg}:`);
          lines.push(`  (Per-run metrics, pending counts, attempts ledger, and watcher`);
          lines.push(`   lease state are surfaced in Phase 9 — operability layer.)`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/approval-status failed: ${msg}`, "error");
      }
    },
  });
}
