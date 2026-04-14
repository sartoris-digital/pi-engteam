import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";
import { registerSafetyGuard } from "./safety/SafetyGuard.js";
import { Observer } from "./observer/Observer.js";
import { EventWriter } from "./observer/writer.js";
import { HttpSink } from "./observer/httpSink.js";
import { MessageBus } from "./team/MessageBus.js";
import { TeamRuntime } from "./team/TeamRuntime.js";
import { ADWEngine } from "./adw/ADWEngine.js";
import { planBuildReview } from "./workflows/plan-build-review.js";
import { loadSafetyConfig } from "./config.js";
import { createSendMessageTool } from "./team/tools/SendMessage.js";
import { createVerdictEmitTool } from "./team/tools/VerdictEmit.js";
import { createTaskListTool, createTaskUpdateTool } from "./team/tools/TaskList.js";
import { createRequestApprovalTool } from "./team/tools/RequestApproval.js";
import { createGrantApprovalTool } from "./team/tools/GrantApproval.js";
import { registerTeamStartCommand } from "./commands/team-start.js";
import { registerTeamStopCommand } from "./commands/team-stop.js";
import { registerRunStartCommand } from "./commands/run-start.js";
import { registerRunResumeCommand } from "./commands/run-resume.js";
import { registerRunAbortCommand } from "./commands/run-abort.js";
import { registerRunStatusCommand } from "./commands/run-status.js";
import type { AgentDefinition } from "./types.js";

const ENGTEAM_DIR = join(homedir(), ".pi", "engteam");
const RUNS_DIR = join(ENGTEAM_DIR, "runs");

const AGENT_DEFS: AgentDefinition[] = [
  {
    name: "planner",
    description: "Orchestrator — decomposes goals, sequences work, produces plans",
    model: "claude-opus-4-6",
    systemPrompt:
      "You are the Planner agent for the pi-engteam engineering team. " +
      "Decompose the given goal into actionable sub-tasks, identify the specialist agents needed, " +
      "and produce a clear implementation plan. Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "implementer",
    description: "Writes production code and tests per the plan",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are the Implementer agent for the pi-engteam engineering team. " +
      "Read the plan and implement it step by step. Write tests alongside code (TDD). " +
      "For any destructive operation (git push, package install, file delete), call RequestApproval first. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "reviewer",
    description: "Deep code inspection for correctness, maintainability, and regressions",
    model: "claude-opus-4-6",
    systemPrompt:
      "You are the Reviewer agent for the pi-engteam engineering team. " +
      "Carefully read all changed code. Check for logical errors, missing tests, security issues, " +
      "and regression risk. Be specific about any problems — name file, line, and what is wrong. " +
      "Always call VerdictEmit at the end of your turn.",
  },
];

export default async function (pi: ExtensionAPI) {
  await mkdir(RUNS_DIR, { recursive: true });

  const safetyConfig = await loadSafetyConfig();

  registerSafetyGuard(pi, { ...safetyConfig, runsDir: RUNS_DIR });

  const writer = new EventWriter(RUNS_DIR);
  const sinkUrl = process.env.PI_ENGTEAM_EVENT_URL;
  const sink = sinkUrl ? new HttpSink(sinkUrl, "global", RUNS_DIR) : undefined;
  const observer = new Observer(writer, sink);

  const bus = new MessageBus();

  let activeRunId = "none";

  const team = new TeamRuntime({
    cwd: process.cwd(),
    bus,
    observer,
    runsDir: RUNS_DIR,
    customToolsFor: (agentName: string) => {
      const tools = [
        createSendMessageTool(bus, agentName),
        createTaskListTool(RUNS_DIR, activeRunId),
        createTaskUpdateTool(RUNS_DIR, activeRunId),
        createVerdictEmitTool((v) => {
          engine.notifyVerdict(v);
          observer.emit({
            runId: activeRunId,
            agentName,
            category: "verdict",
            type: "emit",
            payload: v,
            summary: `${agentName}: ${v.verdict} on ${v.step}`,
          });
        }),
        createRequestApprovalTool(RUNS_DIR, activeRunId),
      ];
      if (agentName === "judge") {
        tools.push(createGrantApprovalTool(RUNS_DIR, activeRunId));
      }
      return tools;
    },
  });

  const workflows = new Map([["plan-build-review", planBuildReview]]);
  const engine = new ADWEngine({ runsDir: RUNS_DIR, workflows, team, observer });

  const originalStartRun = engine.startRun.bind(engine);
  engine.startRun = async (params) => {
    const state = await originalStartRun(params);
    activeRunId = state.runId;
    return state;
  };

  observer.subscribeToBus(bus, activeRunId);

  registerTeamStartCommand(pi, team, AGENT_DEFS);
  registerTeamStopCommand(pi, team);
  registerRunStartCommand(pi, engine);
  registerRunResumeCommand(pi, engine);
  registerRunAbortCommand(pi, engine);
  registerRunStatusCommand(pi, RUNS_DIR);

  pi.on("session_start", async (event: any, _ctx: any) => {
    if (event.reason === "startup") {
      console.log("[pi-engteam] Extension loaded. Run /team-start to boot the team.");
    }
  });
}
