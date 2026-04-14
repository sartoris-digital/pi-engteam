import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunStartCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand({
    name: "run-start",
    description: "Start a workflow run. Usage: /run-start plan-build-review \"Add login feature\"",
    argsSchema: Type.Object({
      workflow: Type.String({
        description: "Workflow name: plan-build-review, investigate, triage, verify, debug",
      }),
      goal: Type.String({
        description: "Goal description — what the team should accomplish",
      }),
      maxIterations: Type.Optional(
        Type.Number({ description: "Max fix iterations (default 8)" }),
      ),
      maxCostUsd: Type.Optional(
        Type.Number({ description: "Max cost in USD (default 20)" }),
      ),
    }),
    handler: async (args, _ctx) => {
      const run = await engine.startRun({
        workflow: args.workflow,
        goal: args.goal,
        budget: {
          maxIterations: args.maxIterations,
          maxCostUsd: args.maxCostUsd,
        },
      });
      void engine.executeRun(run.runId);
      return {
        message: [
          `Run ${run.runId} started.`,
          `Workflow: ${args.workflow}`,
          `Goal: ${args.goal}`,
          `Monitor: ~/.pi/engteam/runs/${run.runId}/events.jsonl`,
        ].join("\n"),
        runId: run.runId,
      };
    },
  });
}
