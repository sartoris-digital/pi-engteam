import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ADWEngine } from "../adw/ADWEngine.js";

export function registerRunAbortCommand(pi: ExtensionAPI, engine: ADWEngine): void {
  pi.registerCommand({
    name: "run-abort",
    description: "Abort a running workflow, revoke approval tokens, and clean up",
    argsSchema: Type.Object({
      runId: Type.String({ description: "Run ID to abort" }),
    }),
    handler: async (args, _ctx) => {
      await engine.abortRun(args.runId);
      return { message: `Run ${args.runId} aborted.` };
    },
  });
}
