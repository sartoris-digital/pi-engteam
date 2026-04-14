import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunResumeCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand({
    name: "run-resume",
    description: "Resume a paused or interrupted workflow run",
    argsSchema: Type.Object({
      runId: Type.String({ description: "Run ID from /run-start output" }),
    }),
    handler: async (args, _ctx) => {
      void engine.resumeRun(args.runId);
      return { message: `Run ${args.runId} resuming...` };
    },
  });
}
