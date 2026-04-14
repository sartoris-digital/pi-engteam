import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { AgentDefinition } from "../types.js";

export function registerTeamStartCommand(
  pi: ExtensionAPI,
  team: TeamRuntime,
  agentDefs: AgentDefinition[],
): void {
  pi.registerCommand({
    name: "team-start",
    description: "Boot the pi-engteam TeamRuntime and spawn all agents in idle state",
    argsSchema: Type.Object({}),
    handler: async (_args, _ctx) => {
      await team.ensureAllTeammates(agentDefs);
      return {
        message: `Team booted with ${agentDefs.length} agents. Run /run-start <workflow> "<goal>" to begin.`,
      };
    },
  });
}
