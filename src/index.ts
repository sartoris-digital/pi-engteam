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
import { planBuildReviewFix } from "./workflows/plan-build-review-fix.js";
import { investigate } from "./workflows/investigate.js";
import { triage } from "./workflows/triage.js";
import { verify } from "./workflows/verify.js";
import { debug } from "./workflows/debug.js";
import { fixLoop } from "./workflows/fix-loop.js";
import { migration } from "./workflows/migration.js";
import { refactorCampaign } from "./workflows/refactor-campaign.js";
import { docBackfill } from "./workflows/doc-backfill.js";
import { specPlanBuildReview } from "./workflows/spec-plan-build-review.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerObserveCommand } from "./commands/observe.js";
import { registerWorkflowShortcuts } from "./commands/workflow-shortcuts.js";
import { registerSpecCommand } from "./commands/spec.js";
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
  {
    name: "discoverer",
    description: "Generates discovery questions to understand feature requirements before spec writing",
    model: "claude-haiku-4-5-20251001",
    systemPrompt:
      "You are the Discoverer agent for the pi-engteam engineering team. " +
      "Analyze the feature goal and write 3-5 focused discovery questions in a questions.md file. " +
      "Categories must be exactly: SCOPE, CONSTRAINTS, SUCCESS, CONTEXT. " +
      "Use numbered lists under each ## heading. Keep each question to one sentence. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "architect",
    description: "Writes feature specifications from goals and answered discovery questions",
    model: "claude-opus-4-6",
    systemPrompt:
      "You are the Architect agent for the pi-engteam engineering team. " +
      "Read the discovery answers and write a precise, complete feature specification in spec.md. " +
      "Use the ADR-style sections: Problem, Approach, Acceptance Criteria, Key Interfaces, Out of Scope, Open Questions. " +
      "Be specific — no padding or vague statements. " +
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
          engine.notifyVerdict(activeRunId, v);
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

  const workflows = new Map([
    ["plan-build-review", planBuildReview],
    ["plan-build-review-fix", planBuildReviewFix],
    ["investigate", investigate],
    ["triage", triage],
    ["verify", verify],
    ["debug", debug],
    ["fix-loop", fixLoop],
    ["migration", migration],
    ["refactor-campaign", refactorCampaign],
    ["doc-backfill", docBackfill],
    ["spec-plan-build-review", specPlanBuildReview],
  ]);
  const engine = new ADWEngine({ runsDir: RUNS_DIR, workflows, team, observer });

  const originalStartRun = engine.startRun.bind(engine);
  engine.startRun = async (params) => {
    const state = await originalStartRun(params);
    activeRunId = state.runId;
    return state;
  };

  observer.subscribeToBus(bus, activeRunId);

  registerDoctorCommand(pi);
  registerObserveCommand(pi);
  registerWorkflowShortcuts(pi, engine);
  registerSpecCommand(pi, engine, team, AGENT_DEFS, RUNS_DIR);
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

  // Input hook: handles "approve" keywords during waiting_user approval phases
  pi.on("input", async (event, ctx) => {
    const { readActiveRun, clearActiveRun } = await import("./adw/ActiveRun.js");
    const activeRun = await readActiveRun();
    if (!activeRun || activeRun.phase !== "approving") return { action: "continue" as const };

    const text = event.text.toLowerCase().trim();
    const isApproval = text === "approve" || text === "approved" || text.includes("looks good");

    if (!isApproval) {
      ctx.ui.notify('Type "approve" when you are ready to continue.', "info");
      return { action: "handled" as const };
    }

    const { runId, stepName } = activeRun;
    await clearActiveRun();

    const stepAckMessages: Record<string, string> = {
      design: "Approved. Running planner…",
      plan: "Approved. Starting build…",
    };
    ctx.ui.notify(stepAckMessages[stepName] ?? "Approved. Resuming…", "info");

    void engine.executeUntilPause(runId).then(state => {
      if (state.status === "waiting_user") {
        readActiveRun().then(ar => {
          if (ar?.stepName === "plan") {
            ctx.ui.notify(
              `plan written → ${join(RUNS_DIR, runId, "plan.md")}\n\nReview the plan, then type "approve" when ready to build.`,
              "info",
            );
          }
        });
      } else if (state.status === "succeeded") {
        ctx.ui.notify("✓ Workflow complete.", "info");
      } else if (state.status === "failed") {
        ctx.ui.notify(`Workflow stopped: step ${state.currentStep} failed.`, "error");
      }
    });

    return { action: "handled" as const };
  });
}
