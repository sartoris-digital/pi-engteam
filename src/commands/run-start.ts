import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunStartCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand("run-start", {
    description:
      "Start a workflow run. Usage: /run-start <workflow> \"<goal>\" [maxIterations] [maxCostUsd]",
    handler: async (args, ctx) => {
      // Parse: workflow "quoted goal" [maxIter] [maxCost]
      const match = args.match(/^(\S+)\s+"([^"]+)"(?:\s+(\d+))?(?:\s+([\d.]+))?$/);
      if (!match) {
        ctx.ui.notify(
          'Usage: /run-start <workflow> "<goal>" [maxIterations] [maxCostUsd]\n' +
            'Example: /run-start plan-build-review "Add login feature"',
          "error",
        );
        return;
      }
      const [, workflow, goal, maxIterStr, maxCostStr] = match;
      const run = await engine.startRun({
        workflow,
        goal,
        budget: {
          maxIterations: maxIterStr ? parseInt(maxIterStr, 10) : undefined,
          maxCostUsd: maxCostStr ? parseFloat(maxCostStr) : undefined,
        },
      });
      // Wire Pi TUI callbacks so the engine surfaces step progress in the footer/notifications
      engine.setUiCallbacks({
        notify: (msg, type) => ctx.ui.notify(msg, type ?? "info"),
        setStatus: (key, text) => ctx.ui.setStatus(key, text),
      });
      // H1: attach rejection handler so workflow errors surface to the user
      engine.executeRun(run.runId).catch((err: unknown) => {
        ctx.ui.notify(
          `Run ${run.runId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      });
      ctx.ui.notify(
        [
          `Run ${run.runId} started.`,
          `Workflow: ${workflow}`,
          `Goal: ${goal}`,
          `Monitor: ~/.pi/engteam/runs/${run.runId}/events.jsonl`,
        ].join("\n"),
        "info",
      );
    },
  });
}
