import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { AgentDefinition } from "../types.js";

export function registerTeamStartCommand(
  pi: ExtensionAPI,
  team: TeamRuntime,
  agentDefs: AgentDefinition[],
): void {
  pi.registerCommand("team-start", {
    description: "Boot the pi-engteam TeamRuntime and spawn all agents in idle state",
    handler: async (_args, ctx) => {
      await team.ensureAllTeammates(agentDefs);
      ctx.ui.notify(
        `Team booted with ${agentDefs.length} agents. Run /run-start <workflow> "<goal>" to begin.`,
        "info",
      );
    },
  });
}
