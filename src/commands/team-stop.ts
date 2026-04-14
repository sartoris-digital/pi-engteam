import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TeamRuntime } from "../team/TeamRuntime.js";

export function registerTeamStopCommand(pi: ExtensionAPI, team: TeamRuntime): void {
  pi.registerCommand({
    name: "team-stop",
    description: "Gracefully shut down all running agent sessions",
    argsSchema: Type.Object({}),
    handler: async (_args, _ctx) => {
      await team.disposeAll();
      return { message: "All agent sessions disposed." };
    },
  });
}
