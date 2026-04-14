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
      void engine.executeRun(run.runId);
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
