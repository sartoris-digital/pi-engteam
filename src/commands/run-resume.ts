import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";
import { isSafeRunId, RUN_ID_RE } from "../adw/RunState.js";

export function registerRunResumeCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand("run-resume", {
    description: "Resume a paused or interrupted workflow run. Usage: /run-resume <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /run-resume <runId>", "error");
        return;
      }
      // Phase 5.5 round-2 C1: reject traversal-shaped runIds at the user
      // boundary before they reach engine.resumeRun → loadRunState.
      if (!isSafeRunId(runId)) {
        ctx.ui.notify(
          `Invalid runId '${runId}': must match ${RUN_ID_RE.source}.`,
          "error",
        );
        return;
      }
      // Phase 5.6 round-4 H1: bind UI callbacks for the resumed run so
      // the TillDone footer surfaces during resumed execution. Without
      // this, /run-resume runs were invisible to the status bar.
      engine.setUiCallbacks(
        {
          notify: (msg, type) => ctx.ui.notify(msg, type ?? "info"),
          setStatus: (key, text) => ctx.ui.setStatus(key, text),
        },
        runId,
      );
      // Codex round-4 MEDIUM: previously `void engine.resumeRun(runId)`
      // discarded async errors — a corrupt state.json, missing workflow,
      // or terminal-status run printed a misleading "resuming..." with no
      // follow-up. Attach a catch so failures surface to the UI with the
      // actual error and a hint pointing at /run-status for diagnosis.
      engine.resumeRun(runId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `Run ${runId} resume failed: ${msg}\nInspect with: /run-status ${runId}`,
          "error",
        );
      });
      ctx.ui.notify(`Run ${runId} resuming...`, "info");
    },
  });
}
