import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TeamRuntime } from "../team/TeamRuntime.js";

export function registerTeamStopCommand(pi: ExtensionAPI, team: TeamRuntime): void {
  pi.registerCommand("team-stop", {
    description: "Gracefully shut down all running agent sessions",
    handler: async (_args, ctx) => {
      await team.disposeAll();
      ctx.ui.notify("All agent sessions disposed.", "info");
    },
  });
}
