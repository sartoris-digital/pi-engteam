// src/commands/approval-watcher.ts
//
// PLAN.md ApprovalWatcher Phase 2 — slash command for operator
// mutations of the approval-watcher state machine. All sub-actions
// write to the audit log and (where applicable) mutate
// `~/.pi/engineering-team/safety.json` via atomic temp+rename.
//
// Phase 2 lands the command surface + flag-flip semantics. The
// stale-state-mutation work that `/approval-watcher reengage` and
// `/approval-watcher rescan` describe lands in Phase 8 (the watcher
// core) — Phase 2 stubs them with a clear "not yet wired" notice so
// operators can call them and see the limitation explicitly rather
// than discovering a silent no-op.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { loadSafetyConfig } from "../config.js";
import { writeApprovalAuditLine } from "../safety/approval-watcher-audit.js";
import { isSafeRunId, loadRunState, saveRunState, withRunStateLock } from "../adw/RunState.js";
import type { ApprovalWatcherConfig } from "../types.js";

const SAFETY_JSON_PATH = () => join(homedir(), ".pi", "engineering-team", "safety.json");

async function mutateApprovalWatcherConfig(
  mutate: (cfg: ApprovalWatcherConfig) => ApprovalWatcherConfig,
): Promise<ApprovalWatcherConfig> {
  // Atomic config write: read → mutate → write via tmp+rename so a
  // crash or concurrent reader never sees a torn safety.json.
  const path = SAFETY_JSON_PATH();
  const tmp = path + ".tmp";
  const current = await loadSafetyConfig();
  const nextWatcher = mutate(current.approvalWatcher!);
  const next = { ...current, approvalWatcher: nextWatcher };
  await mkdir(join(homedir(), ".pi", "engineering-team"), { recursive: true, mode: 0o700 });
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  return nextWatcher;
}

function parseHoursFlag(args: string): { hours?: number; rest: string } {
  const m = args.match(/--hours\s+(\d+(?:\.\d+)?)\b/);
  if (!m) return { rest: args };
  const hours = parseFloat(m[1]);
  if (!Number.isFinite(hours) || hours <= 0) return { rest: args };
  return { hours, rest: args.replace(m[0], "").trim() };
}

function parseReasonFlag(args: string): { reason?: string; rest: string } {
  const m = args.match(/--reason\s+"([^"]+)"/) || args.match(/--reason\s+(\S+)/);
  if (!m) return { rest: args };
  return { reason: m[1], rest: args.replace(m[0], "").trim() };
}

function hasFlag(args: string, flag: string): boolean {
  return new RegExp(`(^|\\s)${flag}(\\s|$)`).test(args);
}

export function registerApprovalWatcherCommand(pi: ExtensionAPI, runsDir: string): void {
  pi.registerCommand("approval-watcher", {
    description:
      "Operate the approval watcher. Usage: /approval-watcher pause|resume|reengage <runId>|extend-hold <runId> --hours N|rescan|resume-after-emergency --acknowledge --reason \"<text>\"",
    handler: async (raw, ctx) => {
      const args = raw.trim();
      const firstSpace = args.indexOf(" ");
      const subcommand = (firstSpace === -1 ? args : args.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? "" : args.slice(firstSpace + 1).trim();

      if (!subcommand) {
        ctx.ui.notify(
          [
            "Usage: /approval-watcher <subcommand>",
            "  pause                          — stop dispatch (in-flight Judges complete)",
            "  resume                         — undo pause",
            "  reengage <runId>               — drain stale pending backlog under lease",
            "  extend-hold <runId> --hours N  — bump adhoc-shell hold expiry",
            "  rescan                         — re-run boot-time priority sort",
            "  resume-after-emergency --acknowledge --reason \"<text>\" — clear emergencyStop",
          ].join("\n"),
          "info",
        );
        return;
      }

      try {
        switch (subcommand) {
          case "pause": {
            const next = await mutateApprovalWatcherConfig((c) => ({ ...c, dispatchPaused: true }));
            await writeApprovalAuditLine({ action: "pause", payload: { dispatchPaused: next.dispatchPaused } });
            ctx.ui.notify("approval-watcher paused. In-flight Judges complete; no new dispatches.", "info");
            return;
          }
          case "resume": {
            const next = await mutateApprovalWatcherConfig((c) => ({ ...c, dispatchPaused: false }));
            await writeApprovalAuditLine({ action: "resume", payload: { dispatchPaused: next.dispatchPaused } });
            ctx.ui.notify("approval-watcher resumed.", "info");
            return;
          }
          case "reengage": {
            const runId = rest.trim();
            if (!isSafeRunId(runId)) {
              ctx.ui.notify(`Invalid runId '${runId}'. Usage: /approval-watcher reengage <runId>`, "error");
              return;
            }
            // Phase 2: write audit + append liveness ping. Phase 8 wires
            // the actual lease acquisition + stale-backlog cleanup.
            await writeApprovalAuditLine({ action: "reengage", runId });
            try {
              const ping = JSON.stringify({ source: "approval-watcher reengage", ts: new Date().toISOString() }) + "\n";
              await mkdir(join(runsDir, runId), { recursive: true });
              const { appendFile } = await import("fs/promises");
              await appendFile(join(runsDir, runId, ".liveness-pings.jsonl"), ping, { mode: 0o600 });
            } catch { /* best-effort */ }
            ctx.ui.notify(
              `reengage ${runId}: liveness ping appended + audit line written. Stale-backlog cleanup runs in Phase 8 (watcher core).`,
              "info",
            );
            return;
          }
          case "extend-hold": {
            const runId = rest.split(/\s+/)[0]?.trim() ?? "";
            if (!isSafeRunId(runId)) {
              ctx.ui.notify(
                `Invalid runId '${runId}'. Usage: /approval-watcher extend-hold <runId> --hours N`,
                "error",
              );
              return;
            }
            const { hours } = parseHoursFlag(rest);
            if (!hours) {
              ctx.ui.notify("Missing or invalid --hours N (positive number).", "error");
              return;
            }
            const outcome = await withRunStateLock(runsDir, runId, async () => {
              const state = await loadRunState(runsDir, runId);
              if (!state) return { kind: "not-found" as const };
              const newExpiry = new Date(Date.now() + hours * 3600 * 1000).toISOString();
              await saveRunState(runsDir, { ...state, adhocHoldExpiresAt: newExpiry });
              return { kind: "ok" as const, expiresAt: newExpiry };
            });
            if (outcome.kind === "not-found") {
              ctx.ui.notify(`Run ${runId} not found.`, "error");
              return;
            }
            await writeApprovalAuditLine({
              action: "extend-hold",
              runId,
              payload: { hours, adhocHoldExpiresAt: outcome.expiresAt },
            });
            ctx.ui.notify(
              `extend-hold ${runId}: hold expires at ${outcome.expiresAt}.`,
              "info",
            );
            return;
          }
          case "rescan": {
            await writeApprovalAuditLine({ action: "rescan" });
            ctx.ui.notify(
              "rescan: audit line written. Watcher priority re-sort wires in Phase 9 (operability layer).",
              "info",
            );
            return;
          }
          case "resume-after-emergency": {
            if (!hasFlag(rest, "--acknowledge")) {
              ctx.ui.notify(
                "Refusing to resume: pass --acknowledge to confirm you have reviewed the incident.",
                "error",
              );
              return;
            }
            const { reason } = parseReasonFlag(rest);
            if (!reason) {
              ctx.ui.notify(
                'Refusing to resume: pass --reason "<short explanation>" so the audit log is meaningful.',
                "error",
              );
              return;
            }
            const next = await mutateApprovalWatcherConfig((c) => ({
              ...c,
              emergencyStop: false,
              pauseEpoch: c.pauseEpoch + 1,
            }));
            await writeApprovalAuditLine({
              action: "resume-after-emergency",
              reason,
              payload: { emergencyStop: next.emergencyStop, pauseEpoch: next.pauseEpoch },
            });
            ctx.ui.notify(
              `Emergency cleared. pauseEpoch incremented to ${next.pauseEpoch}; pre-stop tokens are now rejected by epoch mismatch.`,
              "info",
            );
            return;
          }
          default:
            ctx.ui.notify(
              `Unknown subcommand '${subcommand}'. Run /approval-watcher (no args) for usage.`,
              "error",
            );
            return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/approval-watcher ${subcommand} failed: ${msg}`, "error");
      }
    },
  });
}
