import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";
import { registerSafetyGuard, registerHardBlockers } from "./safety/SafetyGuard.js";
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
import { issueAnalyze } from "./workflows/issue-analyze.js";
import { consult, buildConsultWorkflow } from "./workflows/consult.js";
import { registerIssueCommand } from "./commands/issue.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerObserveCommand } from "./commands/observe.js";
import { registerWorkflowShortcuts } from "./commands/workflow-shortcuts.js";
import { registerSpecCommand } from "./commands/spec.js";
import { registerLearnCommand } from "./commands/learn.js";
import { loadSafetyConfig, loadModelRouting } from "./config.js";
import { loadTeamsConfig } from "./safety/teams-config.js";
import { createSendMessageTool } from "./team/tools/SendMessage.js";
import { createVerdictEmitTool } from "./team/tools/VerdictEmit.js";
import {
  createTaskListTool,
  createTaskUpdateTool,
  loadTasks,
  unassignedTasks,
  liveTasks,
  TASK_ID_RE,
} from "./team/tools/TaskList.js";
import { createRequestApprovalTool } from "./team/tools/RequestApproval.js";
import { createGrantApprovalTool } from "./team/tools/GrantApproval.js";
import { registerRunStartCommand } from "./commands/run-start.js";
import { registerRunResumeCommand } from "./commands/run-resume.js";
import { registerRunAbortCommand } from "./commands/run-abort.js";
import { registerRunCancelCommand } from "./commands/run-cancel.js";
import { registerRunRollbackCommand } from "./commands/run-rollback.js";
import { registerRunPlanModeCommand } from "./commands/run-plan-mode.js";
import { registerRunStatusCommand } from "./commands/run-status.js";
import { loadMemoryConfig } from "./memory/config.js";
import { MemoryCore } from "./memory/MemoryCore.js";
import {
  DEFAULT_EXPERTISE_CONFIG,
  readExpertise,
  readReadonly,
  resolveDirs,
} from "./memory/ExpertiseStore.js";
import type { AgentDefinition } from "./types.js";
import { Vault } from "./secrets/Vault.js";
import { MasterKeyManager } from "./secrets/MasterKey.js";
import { createKeyringBackend } from "./secrets/Keyring.js";
import { createSecretResolver } from "./secrets/SecretResolver.js";
import { createUseSecretTool } from "./secrets/UseSecret.js";
import { defaultSpawn } from "./secrets/spawn.js";
import { registerWatcher } from "./secrets/Integration.js";
import { loadPatterns } from "./secrets/patterns.js";
import { registerSecretSetCommand } from "./commands/secret-set.js";
import { registerSecretListCommand } from "./commands/secret-list.js";
import { registerSecretRmCommand } from "./commands/secret-rm.js";
import { registerSecretRotateCommand } from "./commands/secret-rotate.js";
import { registerSecretExportCommand } from "./commands/secret-export.js";
import { registerSecretImportCommand } from "./commands/secret-import.js";
import { registerSecretScrubCommand } from "./commands/secret-scrub.js";
import { RateLimitGuard } from "./rateLimit/RateLimitGuard.js";
import { loadRateLimitConfig } from "./rateLimit/config.js";

const ENGINEERING_DIR = join(homedir(), ".pi", "engineering-team");
const RUNS_DIR = join(ENGINEERING_DIR, "runs");

export const AGENT_DEFS: AgentDefinition[] = [
  {
    name: "planner",
    description: "Orchestrator — decomposes goals, sequences work, produces plans",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Planner agent for the pi-engineering engineering team. " +
      "Decompose the given goal into actionable sub-tasks, identify the specialist agents needed, " +
      "and produce a clear implementation plan. Always call VerdictEmit at the end of your turn.",
    team: "planning",
  },
  {
    name: "implementer",
    description: "Writes production code and tests per the plan",
    model: "zenmux/anthropic/claude-sonnet-4.6",
    systemPrompt:
      "You are the Implementer agent for the pi-engineering engineering team. " +
      "Read the plan and implement it step by step. Write tests alongside code (TDD). " +
      "For any destructive operation (git push, package install, file delete), call RequestApproval first. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "engineering",
  },
  {
    name: "reviewer",
    description: "Deep code inspection for correctness, maintainability, and regressions",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Reviewer agent for the pi-engineering engineering team. " +
      "Carefully read all changed code. Check for logical errors, missing tests, security issues, " +
      "and regression risk. Be specific about any problems — name file, line, and what is wrong. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "validation",
  },
  {
    name: "discoverer",
    description: "Generates discovery questions to understand feature requirements before spec writing",
    model: "zenmux/anthropic/claude-haiku-4.5",
    systemPrompt:
      "You are the Discoverer agent for the pi-engineering engineering team. " +
      "Analyze the feature goal and write 3-5 focused discovery questions in a questions.md file. " +
      "Categories must be exactly: SCOPE, CONSTRAINTS, SUCCESS, CONTEXT. " +
      "Use numbered lists under each ## heading. Keep each question to one sentence. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "planning",
  },
  {
    name: "architect",
    description: "Writes feature specifications from goals and answered discovery questions",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Architect agent for the pi-engineering engineering team. " +
      "Read the discovery answers and write a precise, complete feature specification in spec.md. " +
      "Use the ADR-style sections: Problem, Approach, Acceptance Criteria, Key Interfaces, Out of Scope, Open Questions. " +
      "Be specific — no padding or vague statements. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "planning",
  },
  {
    name: "issue-analyst",
    description: "Fetches issue tickets from GitHub, ADO, or Jira CLIs and extracts structured requirements",
    model: "zenmux/anthropic/claude-haiku-4.5",
    systemPrompt:
      "You are the Issue Analyst agent for the pi-engineering engineering team. " +
      "Read the goal to get the ticket reference and tracker type. " +
      "Fetch the ticket using the appropriate pre-authenticated CLI (gh, az, or jira). " +
      "Extract the requirements and write issue-brief.md with all required sections. " +
      "Select the appropriate downstream workflow based on issue type. " +
      "Always call VerdictEmit at the end of your turn with step='analyze'.",
    team: "investigation",
  },
  {
    name: "root-cause-debugger",
    description: "Deep code-path analysis using competing-hypothesis investigation",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Root Cause Debugger agent for the pi-engineering engineering team. " +
      "Use a seven-stage competing-hypothesis protocol: Observe → Hypothesize (≥2 competing causes) → Gather evidence for each → Rebuttal round → Rank by evidence weight → Synthesize → Probe to close gaps. " +
      "Trace failures to file:line. Produce a fix-plan.md with ranked fix options and rollback plans. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "engineering",
  },
  {
    name: "tester",
    description: "Creates unit, integration, and regression tests. Validates fixes.",
    model: "zenmux/anthropic/claude-sonnet-4.6",
    systemPrompt:
      "You are the Tester agent for the pi-engineering engineering team. " +
      "Write the failing test first, verify it fails, then validate the fix makes it pass. " +
      "Use vitest and follow patterns in tests/unit/ and tests/integration/. " +
      "Run pnpm test to confirm 0 failures before calling VerdictEmit. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "validation",
  },
  {
    name: "judge",
    description: "Final verdict authority. Signs approval tokens for sensitive operations.",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Judge agent for the pi-engineering engineering team. " +
      "You are the final gate before a workflow completes or a sensitive operation executes. " +
      "Before voting PASS: run git diff to see what changed, confirm test output shows 0 failures, verify all reviewer issues are addressed, and confirm the implementation matches the stated goal. " +
      "You are the only agent authorized to call GrantApproval. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "cross-functional",
  },
  {
    name: "knowledge-retriever",
    description: "Fetches and summarizes relevant code, docs, ADRs, and tickets for other agents",
    model: "zenmux/anthropic/claude-sonnet-4.6",
    systemPrompt:
      "You are the Knowledge Retriever agent for the pi-engineering engineering team. " +
      "Search the codebase, docs, and ADR directories for content relevant to the stated goal. " +
      "Summarize findings into a context-pack.md with grounded, project-specific context. Explicitly state what you could not find. " +
      "Check file size before reading; cap parallel reads at 5 files per round. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "planning",
  },
  {
    name: "incident-investigator",
    description: "Pulls logs, traces, metrics; builds competing-hypothesis probable-cause tree for incidents",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Incident Investigator agent for the pi-engineering engineering team. " +
      "Use a seven-stage competing-hypothesis protocol: Observe → Hypothesize (≥2 competing causes) → Gather evidence for each → Rebuttal round → Rank by evidence weight → Synthesize → Probe to close gaps. " +
      "Pull from events.jsonl, metrics, logs, and recent commits. Include a Timeline section in your report. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "investigation",
  },
  {
    name: "bug-triage",
    description: "Classifies bugs, assigns severity P0–P3, routes to the right owner",
    model: "zenmux/anthropic/claude-haiku-4.5",
    systemPrompt:
      "You are the Bug Triage agent for the pi-engineering engineering team. " +
      "Read the bug report, search the codebase for the likely defect location, check for duplicate reports, " +
      "assign severity (P0 critical / P1 high / P2 medium / P3 low), determine the responsible owner area, " +
      "and write a triage summary in verdict.md. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "investigation",
  },
  {
    name: "security-auditor",
    description: "Static analysis, secrets scanning, auth and dependency review",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Security Auditor agent for the pi-engineering engineering team. " +
      "Scan changed files for insecure patterns (injection, hardcoded secrets, missing auth checks), " +
      "check dependencies for CVEs via pnpm audit, and review auth and permission boundaries. " +
      "Write security-report.md with all findings classified by severity. You are read-only — report only, never patch. " +
      "If you find Critical or High severity issues you MUST emit FAIL. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "validation",
  },
  {
    name: "codebase-cartographer",
    description: "Maps modules, dependencies, conventions, and risk areas before significant changes",
    model: "zenmux/anthropic/claude-sonnet-4.6",
    systemPrompt:
      "You are the Codebase Cartographer agent for the pi-engineering engineering team. " +
      "Map the modules and files relevant to the stated goal, identify dependency chains and integration points, " +
      "find existing conventions (naming, error handling, test patterns), and flag hotspots. " +
      "Write codebase-map.md summarizing your findings. Check file size before reading; cap parallel reads at 5 files per round. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "planning",
  },
  {
    name: "observability-archivist",
    description: "Reads event streams, builds trace timelines, identifies patterns and anomalies",
    model: "zenmux/anthropic/claude-sonnet-4.6",
    systemPrompt:
      "You are the Observability Archivist agent for the pi-engineering engineering team. " +
      "Read the event stream from ~/.pi/engineering-team/runs/{runId}/events.jsonl. " +
      "Build a trace timeline, identify slow steps and frequent failures, and surface anomalies. " +
      "Write observation-report.md with a timeline, performance breakdown, and actionable insights. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "investigation",
  },
  {
    name: "performance-analyst",
    description: "Latency, N+1, memory, and concurrency review",
    model: "zenmux/anthropic/claude-sonnet-4.6",
    systemPrompt:
      "You are the Performance Analyst agent for the pi-engineering engineering team. " +
      "Analyze code paths for latency hot spots, N+1 query patterns, memory pressure, and concurrency hazards. " +
      "Profile when tooling is available; otherwise read the code carefully and report bounded reasoning. " +
      "Write performance-report.md with concrete file:line references and remediation suggestions. " +
      "Always call VerdictEmit at the end of your turn.",
    team: "engineering",
  },
  {
    name: "verifier",
    description: "Read-only verifier — atomizes worker claims, runs deterministic scripts, emits PASS/FAIL/PARTIAL with STATUS/CONFIDENCE",
    model: "zenmux/anthropic/claude-sonnet-4.6",
    systemPrompt:
      "You are the Verifier. You observe; you do not author. " +
      "Atomize each worker claim and verify it via deterministic scripts under ~/.pi/engineering-team/verifier-scripts/ invoked through 'uv run --script'. " +
      "Always begin reports with STATUS: (PASS|FAIL|PARTIAL) and CONFIDENCE: (PERFECT|VERIFIED|PARTIAL|FEEDBACK|FAILED). " +
      "You are read-only: no Write or Edit, and Bash is restricted to the verifier-script allowlist enforced by SafetyGuard Layer D. " +
      "Always end your turn with VerdictEmit.",
    tools: ["Read", "Grep", "Glob", "Bash", "SendMessage", "VerdictEmit"],
    team: "cross-functional",
  },
  {
    name: "learner",
    description: "Privileged on-demand agent — converts verifier gap logs into staged verifier-script upgrades for Judge approval",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Learner. Three safety gates protect every promotion: (1) domain lock — your writes MUST stay under ~/.pi/engineering-team/verifier-scripts/.staging/ and <runDir>/learning/; (2) Judge approval — every staged script requires an HMAC-signed token from the Judge; (3) fixture validation — every staged script must pass its new fixture AND every existing fixture before the orchestrator promotes it. " +
      "Read <runDir>/learning/gaps.jsonl, classify gaps, write proposals to .staging/, and request Judge approval for each via RequestApproval. Never bypass the orchestrator's atomic promotion. " +
      "Always end your turn with VerdictEmit.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit", "SendMessage", "VerdictEmit", "RequestApproval"],
    team: "cross-functional",
  },
  // --- Lead tier ---
  {
    name: "planning-lead",
    description: "Coordinates the Planning team: planner, architect, discoverer, codebase-cartographer, knowledge-retriever",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Planning Lead. You delegate; you do not execute. " +
      "Coordinate Planning workers (planner, architect, discoverer, codebase-cartographer, knowledge-retriever) via SendMessage; synthesize their VerdictEmit outputs into a single team position. " +
      "Never SendMessage cross-team workers — escalate scope expansion to the Orchestrator. Always end your turn with VerdictEmit. " +
      "Write/Edit are only for consult artifacts under <run>/positions/ and <run>/adversarial/, and (when explicitly directed) for spec drafts under specs/.",
    tools: ["SendMessage", "TaskUpdate", "TaskList", "VerdictEmit", "Read", "Grep", "Glob", "Write", "Edit"],
    team: "planning",
  },
  {
    name: "engineering-lead",
    description: "Coordinates the Engineering team: implementer, root-cause-debugger, performance-analyst",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Engineering Lead. You delegate; you do not execute. " +
      "Coordinate Engineering workers (implementer, root-cause-debugger, performance-analyst) via SendMessage; synthesize their VerdictEmit outputs into a single team position. " +
      "Never send workers outside their declared domain — escalate scope expansion to the Orchestrator. Always end your turn with VerdictEmit. " +
      "Write/Edit are only for consult artifacts under <run>/positions/ and <run>/adversarial/.",
    // Phase 4.5 round-4 H3 (deferred → closed): consult workflow expects
    // Leads to write <run>/positions/<lead>.md and <run>/adversarial/<lead>.md.
    // Layer D domain policy already constrains writes to ${RUN_DIR}; Layer A
    // hard-blocks expertise + tasks.json regardless of agent allowlist.
    tools: ["SendMessage", "TaskUpdate", "TaskList", "VerdictEmit", "Read", "Grep", "Glob", "Write", "Edit"],
    team: "engineering",
  },
  {
    name: "validation-lead",
    description: "Coordinates the Validation team: reviewer, tester, security-auditor",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Validation Lead. You delegate; you do not execute. " +
      "Coordinate Validation workers (reviewer, tester, security-auditor) via SendMessage; a security-auditor Critical/High FAIL is blocking and must be escalated to the Orchestrator intact. " +
      "Never write code or modify tests. Always end your turn with VerdictEmit. " +
      "Write/Edit are only for consult artifacts under <run>/positions/ and <run>/adversarial/.",
    tools: ["SendMessage", "TaskUpdate", "TaskList", "VerdictEmit", "Read", "Grep", "Glob", "Write", "Edit"],
    team: "validation",
  },
  {
    name: "investigation-lead",
    description: "Coordinates the Investigation team: incident-investigator, bug-triage, observability-archivist, issue-analyst",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Investigation Lead. You delegate; you do not execute. " +
      "Coordinate Investigation workers (incident-investigator, bug-triage, observability-archivist, issue-analyst) via SendMessage; incident syntheses must include a Timeline section. " +
      "Never write code or modify production state — escalate remediation to the Orchestrator. Always end your turn with VerdictEmit. " +
      "Write/Edit are only for consult artifacts under <run>/positions/ and <run>/adversarial/.",
    tools: ["SendMessage", "TaskUpdate", "TaskList", "VerdictEmit", "Read", "Grep", "Glob", "Write", "Edit"],
    team: "investigation",
  },
  {
    name: "orchestrator",
    description: "Top-level router. Classifies user requests, decomposes into team tasks, dispatches to Leads in parallel by default, synthesizes responses.",
    model: "zenmux/anthropic/claude-opus-4.6",
    systemPrompt:
      "You are the Orchestrator. You delegate; you do not execute. " +
      "Classify every user request, decompose into team-shaped tasks, dispatch to Leads (planning-lead, engineering-lead, validation-lead, investigation-lead) via SendMessage — never address workers directly. " +
      "Synthesize Lead VerdictEmit outputs back to the user. Always end your turn with VerdictEmit. " +
      "Write/Edit are scoped to the consult synthesis artifact <run>/synthesis.md.",
    tools: ["SendMessage", "TaskUpdate", "TaskList", "VerdictEmit", "Read", "Grep", "Glob", "Write", "Edit"],
    team: "orchestrator",
  },
];

export default async function (pi: ExtensionAPI) {
  // ── Agent subprocess mode ──────────────────────────────────────────────────
  // When PI_ENGINEERING_AGENT_MODE=1, this extension is loaded inside a pi subprocess
  // spawned by TeamRuntime.deliver(). Register agent-facing tools only — skip all
  // controller infrastructure (server, observer, commands, TeamRuntime).
  if (process.env["PI_ENGINEERING_AGENT_MODE"]) {
    // C2: apply Layer A hard blockers + Layer D domain lock in subprocess mode.
    const subTeamsCfg = await loadTeamsConfig({
      userPath: join(ENGINEERING_DIR, "teams.yaml"),
      projectPath: join(process.cwd(), ".pi", "engineering-team", "teams.local.yaml"),
      runDir: RUNS_DIR,
      expertiseDir: join(ENGINEERING_DIR, "expertise"),
    });
    // Phase 5.5 round-3 M1: pass runsDir so the tasks.json hard-block
    // works under non-standard runsDir layouts (e.g., a custom path
    // that doesn't include /runs/ in its name).
    registerHardBlockers(pi, {
      hardBlockers: { enabled: true, alwaysOn: true },
      runsDir: process.env["PI_ENGINEERING_RUNS_DIR"] ?? RUNS_DIR,
      domainLock: {
        policies: subTeamsCfg.domains,
        mode: subTeamsCfg.mode,
        emitEvent: () => { /* no observer in subprocess; event is a no-op */ },
      },
    });

    // Enforce per-agent tool allowlist at the tool_call boundary. Pi's runtime
    // exposes the same tool registry to every agent; without this hook,
    // declaring tools: [...] on an AgentDefinition is metadata-only. Leads MUST
    // NOT execute Write/Edit/Bash; this is the runtime gate that enforces it.
    const subAgentName = process.env["PI_ENGINEERING_AGENT_NAME"] ?? "";
    const subAgentDef = AGENT_DEFS.find((a) => a.name === subAgentName);
    const { normalizeToolEvent } = await import("./safety/SafetyGuard.js");
    const subAgentTools = subAgentDef?.tools;
    if (subAgentTools && subAgentTools.length > 0) {
      // Normalize allowed list: lowercase form for built-ins so we match
      // Pi's lowercase event.toolName, plus the original entries (custom tools
      // are emitted by their registered name verbatim).
      const allowed = new Set([
        ...subAgentTools,
        ...subAgentTools.map((t) => t.toLowerCase()),
      ]);
      pi.on("tool_call", async (event: any) => {
        const { toolName } = normalizeToolEvent(event);
        const rawName = (event?.toolName ?? event?.tool?.name ?? "") as string;
        if (!allowed.has(toolName) && !allowed.has(rawName) && !allowed.has(rawName.toLowerCase())) {
          return {
            block: true,
            reason: `[Layer D] Agent '${subAgentName}' is not allowed to call tool '${rawName}'. Allowed: ${subAgentTools.join(", ")}.`,
          };
        }
        return undefined;
      });
    } else if (!subAgentDef) {
      // Subprocess started with an empty or unrecognized agent name. Fail closed
      // for any tool that mutates state or accesses secrets — including custom
      // tools like UseSecret that an unknown agent shouldn't be able to invoke.
      // Empty string is treated the same as unknown: better-safe-than-sorry.
      const FAIL_CLOSED_TOOLS = new Set([
        "bash", "write", "edit", "find", // built-ins; "find" because it can -delete
        "UseSecret", "RequestApproval", "GrantApproval", // custom tools that affect state
      ]);
      pi.on("tool_call", async (event: any) => {
        const rawName = (event?.toolName ?? event?.tool?.name ?? "") as string;
        if (FAIL_CLOSED_TOOLS.has(rawName) || FAIL_CLOSED_TOOLS.has(rawName.toLowerCase())) {
          return {
            block: true,
            reason: `[Layer D] Subprocess agent '${subAgentName || "<unset>"}' has no AGENT_DEFS entry; tool '${rawName}' blocked by default.`,
          };
        }
        return undefined;
      });
    }

    // VerdictEmit — writes verdict to PI_ENGINEERING_VERDICT_FILE before exiting.
    pi.registerTool(createVerdictEmitTool((_v) => {}));

    // SendMessage — no live bus in subprocess; agents run independently per step.
    const stubBus = { send: async () => {}, publish: async () => {}, subscribe: () => () => {} } as any;
    pi.registerTool(createSendMessageTool(stubBus, "agent"));

    // TaskList / TaskUpdate — scoped to this subprocess's message ID so agents can
    // track sub-tasks within a step. Files land in runsDir/_subprocess_<id>/.
    const subRunsDir = process.env["PI_ENGINEERING_RUNS_DIR"] ?? RUNS_DIR;
    const subRunId = process.env["PI_ENGINEERING_RUN_ID"] ?? "_subprocess";
    pi.registerTool(createTaskListTool(subRunsDir, subRunId));
    pi.registerTool(createTaskUpdateTool(subRunsDir, subRunId));

    // RequestApproval / GrantApproval — file-based; scoped to this subprocess.
    // H3: only the judge agent gets GrantApproval — gate on PI_ENGINEERING_AGENT_NAME.
    pi.registerTool(createRequestApprovalTool(subRunsDir, subRunId));
    const agentName = process.env["PI_ENGINEERING_AGENT_NAME"] ?? "";
    if (agentName === "judge") {
      pi.registerTool(createGrantApprovalTool(subRunsDir, subRunId));
    }

    // Per-subprocess audit log. Set up BEFORE the vault try block so the
    // tool_call/tool_result drain has somewhere to write even if the vault
    // open fails. Same path the secret resolver appends to (below) and the
    // path TeamRuntime.ingestSubprocessEvents drains on the controller side.
    const subEventDir = join(process.env["PI_ENGINEERING_RUNS_DIR"] ?? RUNS_DIR, process.env["PI_ENGINEERING_RUN_ID"] ?? "_subprocess");
    const { mkdirSync: subMkdirSync, appendFileSync: subAppendFileSync } = await import("fs");
    try { subMkdirSync(subEventDir, { recursive: true }); } catch { /* dir may already exist */ }
    const subEventToken = process.env["PI_ENGINEERING_SUBPROC_EVENT_TOKEN"] ?? `pid-${process.pid}`;
    const subEventFile = join(subEventDir, `events-subprocess-${subEventToken}.jsonl`);

    // Forward every tool_call (and corresponding tool_result, where Pi
    // emits one) the agent makes to the subprocess audit file. The
    // controller drains this file in ingestSubprocessEvents and forwards
    // each line through onSubprocessEvent → observer.emit, so each
    // agent's Write/Edit/Bash/Read shows up in <runDir>/events.jsonl
    // and the /observe dashboard. Without this, only secret-resolver
    // events landed in the audit stream and the dashboard saw nothing
    // tool-level between step.start and step.end.
    const writeAuditLine = (line: object) => {
      try {
        subAppendFileSync(subEventFile, JSON.stringify({ ...line, ts: new Date().toISOString() }) + "\n");
      } catch { /* best-effort; never fail an agent step on audit-write failure */ }
    };
    pi.on("tool_call", async (event: any) => {
      const rawName = (event?.toolName ?? event?.tool?.name ?? "") as string;
      // Cap payload size — some tool args (large file contents) would
      // otherwise blow the audit file up.
      const args = event?.args ?? event?.params ?? undefined;
      const argsStr = args !== undefined ? JSON.stringify(args).slice(0, 2000) : undefined;
      writeAuditLine({
        category: "tool_call",
        type: "invoke",
        payload: { toolName: rawName, args: argsStr },
        summary: `tool_call:${rawName}`,
      });
      return undefined;
    });
    pi.on("tool_result", async (event: any) => {
      const rawName = (event?.toolName ?? event?.tool?.name ?? "") as string;
      writeAuditLine({
        category: "tool_result",
        type: "return",
        payload: { toolName: rawName, blocked: !!event?.blocked },
        summary: `tool_result:${rawName}`,
      });
      return undefined;
    });

    const subVaultDir = join(homedir(), ".pi", "engineering-team");
    const subVaultPath = join(subVaultDir, "secrets.db");
    const subSaltPath = join(subVaultDir, "secrets.salt");
    const subKeyring = createKeyringBackend();
    // Subprocess agents NEVER prompt for a passphrase — TeamRuntime can spawn workers
    // with inherited stdin so isTTY alone is not safe. The agent-mode env var is the
    // canonical signal. Vault unlock is the controller's responsibility.
    const subMasterMgr = new MasterKeyManager({
      keyringBackend: subKeyring,
      saltPath: subSaltPath,
      vaultDbPath: subVaultPath,
      promptFn: undefined,
    });
    try {
      const subKey = await subMasterMgr.ensureInitialized();
      const subVault = new Vault({ dbPath: subVaultPath, masterKey: subKey });
      subVault.init();

      // Close the SQLite handle on process.exit so the WAL is checkpointed
      // cleanly before VerdictEmit's setTimeout(process.exit, 250) fires
      // (Codex round-1 #5 — uncheckpointed WAL frames could be replayed by
      // the next subprocess invocation). process.on("exit") is synchronous
      // and runs for both process.exit() and natural drain-exit, so this
      // covers every termination path the controller can observe.
      process.on("exit", () => { try { subVault.close(); } catch { /* best-effort */ } });
      // Secret-resolver events share the audit file the tool_call drain
      // writes to (set up above before this try). One file per deliver
      // token, drained by TeamRuntime.ingestSubprocessEvents after the
      // subprocess exits.
      const subResolver = createSecretResolver({
        vault: subVault,
        emitEvent: (evt) => writeAuditLine(evt),
      });
      pi.registerTool(createUseSecretTool({ resolver: subResolver, spawnSubprocess: defaultSpawn }));
    } catch (err) {
      // Vault unavailable: register a stub tool so the agent gets an actionable
      // diagnostic instead of a generic "Tool UseSecret not found".
      const reason = err instanceof Error ? err.message : String(err);
      console.warn("[pi-engineering] UseSecret unavailable in subprocess:", reason);
      const stubResolver = {
        resolve: () => {
          throw new Error(
            `UseSecret unavailable: secrets vault could not be unlocked in this subprocess (${reason}). ` +
            `Run /secret-list or /secret-set in a Pi controller session to initialize the vault, then retry.`,
          );
        },
        listNames: () => [],
      };
      pi.registerTool(createUseSecretTool({ resolver: stubResolver, spawnSubprocess: defaultSpawn }));
    }

    return;
  }
  // ── Controller mode (normal Pi session) ────────────────────────────────────

  await mkdir(RUNS_DIR, { recursive: true });

  const VAULT_DIR = ENGINEERING_DIR;
  const VAULT_PATH = join(VAULT_DIR, "secrets.db");
  const VAULT_SALT_PATH = join(VAULT_DIR, "secrets.salt");
  const keyringBackend = createKeyringBackend();
  const { promptPassphrase, isTtyAvailable } = await import("./secrets/Passphrase.js");
  const masterMgr = new MasterKeyManager({
    keyringBackend,
    saltPath: VAULT_SALT_PATH,
    vaultDbPath: VAULT_PATH,
    promptFn: isTtyAvailable() ? promptPassphrase : undefined,
  });

  // Vault is lazy-initialized on first use — we don't force the user to type a passphrase at extension boot if they're not using secrets yet.
  let cachedVault: Vault | null = null;
  async function getVault(): Promise<Vault> {
    if (cachedVault) return cachedVault;
    const masterKey = await masterMgr.ensureInitialized();
    const v = new Vault({ dbPath: VAULT_PATH, masterKey });
    v.init();
    cachedVault = v;
    return v;
  }

  const safetyConfig = await loadSafetyConfig();
  // Per-agent model overrides from ~/.pi/engineering-team/model-routing.json.
  // Users with a different provider than the AGENT_DEFS default (e.g. Copilot
  // instead of zenmux) can redirect agents without editing the extension.
  const modelRouting = await loadModelRouting();
  const memoryConfig = await loadMemoryConfig();
  const memoryCore = new MemoryCore(memoryConfig, RUNS_DIR);

  const teamsCfg = await loadTeamsConfig({
    userPath: join(ENGINEERING_DIR, "teams.yaml"),
    projectPath: join(process.cwd(), ".pi", "engineering-team", "teams.local.yaml"),
    runDir: RUNS_DIR,
    expertiseDir: join(ENGINEERING_DIR, "expertise"),
  });

  const writer = new EventWriter(RUNS_DIR);
  const sinkUrl = process.env.PI_ENGINEERING_EVENT_URL;
  const sink = sinkUrl ? new HttpSink(sinkUrl, "global", RUNS_DIR) : undefined;
  const observer = new Observer(writer, sink, RUNS_DIR);

  // Surface teams.yaml parse errors to operators at boot. Without this, corrupt
  // config silently falls back to defaults and is only visible via /engineering-doctor.
  for (const pe of teamsCfg.parseErrors) {
    observer.emit({
      runId: "boot",
      category: "safety",
      type: "domain_warn" as any,
      payload: { reason: "teams-config-parse-error", path: pe.path, error: pe.error },
      summary: `teams config parse error: ${pe.path}`,
    });
    console.warn(`[pi-engineering] teams config parse error at ${pe.path}: ${pe.error}`);
  }

  const bus = new MessageBus();

  let activeRunId = "none";

  const rateLimitConfig = await loadRateLimitConfig();
  const rateLimitGuard = new RateLimitGuard(rateLimitConfig, (evt) => {
    observer.emit({
      runId: activeRunId,
      category: "budget" as const,
      type: evt.kind === "warn" ? "rate_warn" as any : "rate_pause" as any,
      payload: { provider: evt.provider, saturation_pct: evt.saturationPct },
      summary: `rate ${evt.kind}: ${evt.provider} at ${evt.saturationPct}%`,
    });
  });

  // Phase 5 §8.7: render the agent-bound expertise + read-only knowledge
  // section that gets appended to the agent's system prompt at deliver time.
  const expertiseCfg = { ...DEFAULT_EXPERTISE_CONFIG, ...(memoryConfig.expertise ?? {}) };
  const expertiseDirs = resolveDirs(expertiseCfg, process.cwd());

  // Phase 5.6 round-2 H2: forward declaration so onSubprocessEvent can
  // call engine.refreshTillDoneFooterForRun on TaskUpdate. Engine is
  // constructed below after team; we patch this ref after construction.
  let engineRef: ADWEngine | undefined;

  const team = new TeamRuntime({
    cwd: process.cwd(),
    bus,
    observer,
    runsDir: RUNS_DIR,
    agentDefs: AGENT_DEFS,
    rateLimit: rateLimitGuard,
    modelOverrides: modelRouting.overrides,
    expertiseFor: async (agentName: string) => {
      if (!expertiseCfg.enabled) return "";
      const [exp, ro] = await Promise.all([
        readExpertise(agentName, expertiseDirs),
        readReadonly(agentName, expertiseDirs),
      ]);
      // Phase 5 round-4 M2: aggregate cap on combined output. Per-section
      // caps in ExpertiseStore (8000 + 12000) could compose to 20000+;
      // squash to a hard ceiling so the system prompt size is bounded.
      const COMBINED_CAP = 16000;
      const joined = [exp, ro].filter((s) => s.length > 0).join("\n");
      if (joined.length <= COMBINED_CAP) return joined;
      return joined.slice(0, COMBINED_CAP - 1) + "…";
    },
    // Phase 5.5 §9.2: orchestrator-only host reminders for TillDone team
    // assignment + mark-on-complete nudge. Reads tasks.json, surfaces
    // unassigned/live counts. Other agents see no reminders.
    //
    // Round-1 C1 defense-in-depth: TaskUpdate now validates taskId at
    // write time, but a legacy tasks.json file from before the validator
    // could still contain unsafe ids. Filter ids through the same
    // pattern before injecting into the prompt and elide unsafe ids
    // (replace with a count placeholder).
    systemNotesFor: async (agentName: string, runId: string) => {
      if (agentName !== "orchestrator") return "";
      try {
        const tasks = await loadTasks(RUNS_DIR, runId);
        if (tasks.length === 0) return "";
        const unassigned = unassignedTasks(tasks);
        const live = liveTasks(tasks);
        const lines: string[] = [];
        if (unassigned.length > 0) {
          const safeIds = unassigned
            .map((t) => (TASK_ID_RE.test(t.taskId) ? t.taskId : null))
            .filter((id): id is string => id !== null);
          const ids = safeIds.slice(0, 10).join(", ");
          const elided = unassigned.length - safeIds.length;
          const more =
            (safeIds.length > 10 ? `, +${safeIds.length - 10} more` : "") +
            (elided > 0 ? ` (${elided} unsafe id(s) elided)` : "");
          lines.push(
            `- **${unassigned.length} task(s) pending team assignment**: [${ids}${more}]. ` +
            `Issue TaskUpdate({taskId, status, team: "engineering"|"validation"|"investigation"|"planning"|"cross-functional"}) for each.`,
          );
        }
        if (live.length > 0) {
          lines.push(
            `- **${live.length} task(s) still in flight** (pending or in_progress). ` +
            `Decide whether to continue, escalate, or mark blocked before ending your turn.`,
          );
        }
        return lines.join("\n");
      } catch {
        return "";
      }
    },
    onSubprocessEvent: (runId, agentName, line) => {
      // Phase 4.5 round-4 H2: a worker subprocess writes its own audit
      // events into events-subprocess-<token>.jsonl. The host forwards
      // those into the unified Observer stream, but a worker that
      // declares category="verdict" or "lifecycle" would otherwise enter
      // the projection's privileged paths (kind=correction, kind=note).
      // Whitelist the categories subprocesses may legitimately emit;
      // verdict/lifecycle remain host-only.
      const SUBPROCESS_ALLOWED = new Set([
        "tool_call",
        "tool_result",
        "message",
        "error",
        "budget",
      ]);
      if (!SUBPROCESS_ALLOWED.has(line.category)) return;
      observer.emit({
        runId,
        agentName,
        category: line.category as any,
        type: line.type as any,
        payload: line.payload,
        summary: `${line.category}:${line.type}`,
      });
      // Phase 5.6 round-2 H2: trigger a footer refresh whenever a
      // TaskUpdate fires inside the subprocess so mid-step task ledger
      // changes are reflected in the Pi TUI without waiting for the
      // next step boundary. The refresh is fire-and-forget and seq-
      // guarded so a stale completion can't overwrite a newer one.
      if (
        line.category === "tool_call" &&
        typeof line.payload?.toolName === "string" &&
        line.payload.toolName === "TaskUpdate"
      ) {
        void engineRef?.refreshTillDoneFooterForRun(runId);
      }
    },
    // H2: onVerdictReceived replaces the dead customToolsFor pattern.
    // TeamRuntime.deliver() calls this after reading the subprocess verdict file,
    // giving the host access to learnings/decisions/gotchas before they are stripped.
    onVerdictReceived: (runId, agentName, verdict, hostStep) => {
      memoryCore.onVerdict(runId, verdict, agentName);
      // Round-3 H2: thread the host-controlled step into evt.step so the
      // ConversationProjection's verdict path derives kind from a trusted
      // source. The summary still mentions verdict.step for human-readable
      // audit, but kind/section are driven by hostStep.
      // Round-4 H2: pass {host: true} so the projection's gated verdict
      // path accepts this emit. Worker-emitted verdict events arriving
      // through onSubprocessEvent are now whitelisted out at that gate.
      observer.emit(
        {
          runId,
          agentName,
          step: hostStep,
          category: "verdict",
          type: "emit",
          payload: verdict,
          summary: `${agentName}: ${verdict.verdict} on ${hostStep ?? verdict.step}`,
        },
        { host: true },
      );
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
    ["issue-analyze", issueAnalyze],
    ["consult", consult],
  ]);
  const engine = new ADWEngine({
    runsDir: RUNS_DIR,
    workflows,
    team,
    observer,
    // Phase 6 round-2 H2 + round-3 M1: rebuild ephemeral consult-<random>
    // workflows from persisted RunState after a process restart.
    // consultTeams + rounds.max are stored on the run state by /consult.
    // Inputs are validated to defend against a tampered state.json:
    // workflow name must match `consult-[A-Za-z0-9]+`, rounds.max must
    // be a finite integer in [1, MAX_CONSULT_ROUNDS], consultTeams must
    // be a subset of the known long-form lead names.
    resolveMissingWorkflow: (state) => {
      const MAX_CONSULT_ROUNDS = 5;
      const CONSULT_NAME_RE = /^consult-[A-Za-z0-9]+$/;
      if (!CONSULT_NAME_RE.test(state.workflow)) return undefined;

      const rawRounds = state.rounds?.max;
      const rounds = Number.isFinite(rawRounds) && typeof rawRounds === "number"
        ? Math.max(1, Math.min(MAX_CONSULT_ROUNDS, Math.floor(rawRounds)))
        : 1;

      const ct = (state as unknown as { consultTeams?: unknown }).consultTeams;
      const teamToShort = (name: unknown): "eng" | "valid" | "invest" | undefined => {
        if (name === "engineering-lead") return "eng";
        if (name === "validation-lead") return "valid";
        if (name === "investigation-lead") return "invest";
        return undefined;
      };
      const shortTeams = Array.isArray(ct)
        ? ct.map(teamToShort).filter((s): s is "eng" | "valid" | "invest" => s !== undefined)
        : [];
      const teams = shortTeams.length > 0 ? shortTeams : undefined;
      return buildConsultWorkflow(teams, state.workflow, rounds);
    },
  });
  // Phase 5.6 round-2 H2: bind the forward-declared ref so the TeamRuntime's
  // onSubprocessEvent hook can trigger TillDone footer refreshes mid-step.
  engineRef = engine;

  const originalStartRun = engine.startRun.bind(engine);
  // M5: track the live bus subscription so we can re-subscribe with the correct
  // runId whenever a new run starts (initial "none" is just a placeholder).
  let unsubscribeBus = observer.subscribeToBus(bus, "none");
  engine.startRun = async (params) => {
    const state = await originalStartRun(params);
    activeRunId = state.runId;
    // Replace bus subscription so SendMessage events are logged under the new run
    unsubscribeBus();
    unsubscribeBus = observer.subscribeToBus(bus, state.runId);
    return state;
  };

  // HIGH-3: notify memory core when a run is aborted so aborted runs appear in the daily log
  const originalAbortRun = engine.abortRun.bind(engine);
  engine.abortRun = async (runId: string) => {
    await originalAbortRun(runId);
    memoryCore.onRunAborted(runId);
  };

  registerDoctorCommand(pi);
  registerObserveCommand(pi);
  registerWorkflowShortcuts(pi, engine, RUNS_DIR);
  registerSpecCommand(pi, engine, team, AGENT_DEFS, RUNS_DIR);
  registerIssueCommand(pi, engine, team, AGENT_DEFS, RUNS_DIR);
  registerLearnCommand(pi, team, RUNS_DIR);
  registerRunStartCommand(pi, engine);
  registerRunResumeCommand(pi, engine);
  registerRunAbortCommand(pi, RUNS_DIR);
  registerRunCancelCommand(pi, RUNS_DIR);
  registerRunRollbackCommand(pi, RUNS_DIR);
  registerRunPlanModeCommand(pi, RUNS_DIR);
  registerRunStatusCommand(pi, RUNS_DIR);
  await memoryCore.register(pi);

  const secretEmitEvent = (evt: { category: "safety" | "budget"; type: string; payload: Record<string, unknown> }) => {
    observer.emit({
      runId: activeRunId,
      category: evt.category as any,
      type: evt.type as any,
      payload: evt.payload,
      summary: `${evt.category}:${evt.type}`,
    });
  };

  registerSafetyGuard(pi, {
    ...safetyConfig,
    runsDir: RUNS_DIR,
    domainLock: {
      policies: teamsCfg.domains,
      mode: teamsCfg.mode,
      emitEvent: secretEmitEvent,
    },
  });

  registerSecretSetCommand(pi);
  registerSecretListCommand(pi);
  registerSecretRmCommand(pi);
  registerSecretRotateCommand(pi);
  registerSecretExportCommand(pi);
  registerSecretImportCommand(pi);
  registerSecretScrubCommand(pi);

  try {
    const watcherVault = await getVault();
    registerWatcher(pi, {
      enabled: true,
      interactivePrompt: true,
      onSkipBehavior: "warn",
      entropyEnabled: false,
      vault: watcherVault,
      emitEvent: secretEmitEvent,
      loadPatterns: () => loadPatterns(),
    });
  } catch (err) {
    console.warn("[pi-engineering] Watcher unavailable (vault init failed):", err instanceof Error ? err.message : String(err));
  }

  pi.on("session_start", async (event: any, _ctx: any) => {
    if (event.reason === "startup") {
      // One-time data directory migration: ~/.pi/engteam → ~/.pi/engineering-team
      try {
        const { rename: fsRename, access: fsAccess } = await import("fs/promises");
        const oldEngteamDir = join(homedir(), ".pi", "engteam");
        const newEngineeringDir = join(homedir(), ".pi", "engineering-team");
        let oldExists = false;
        let newExists = false;
        try { await fsAccess(newEngineeringDir); newExists = true; } catch {}
        try { await fsAccess(oldEngteamDir); oldExists = true; } catch {}
        if (!newExists && oldExists) {
          await fsRename(oldEngteamDir, newEngineeringDir);
          console.log("[pi-engineering] Migrated data directory from ~/.pi/engteam to ~/.pi/engineering-team");
        }
      } catch {
        console.warn("[pi-engineering] Could not auto-migrate data dir. Please run: mv ~/.pi/engteam ~/.pi/engineering-team");
      }
      // Phase 6 round-4 H1: an interrupted run (Pi process killed mid-
      // execution) used to be force-marked "aborted" here, which made
      // /run-resume reject the run since resumable statuses are
      // pending/running/paused/waiting_user. Now: leave "waiting_user"
      // alone (it's already resumable) and downgrade "running" to
      // "paused" so the user can /run-resume <runId> after restart.
      // The phase field is also restored to "active" so a stale
      // "cancelling" doesn't immediately end the resumed run.
      try {
        const { readFile, writeFile } = await import("fs/promises");
        const { join } = await import("path");
        const activeFile = join(RUNS_DIR, "active-run.txt");
        const runId = (await readFile(activeFile, "utf8")).trim();
        const stateFile = join(RUNS_DIR, runId, "state.json");
        const state = JSON.parse(await readFile(stateFile, "utf8"));
        const wasRunning = state.status === "running";
        if (wasRunning) {
          state.status = "paused";
          state.updatedAt = new Date().toISOString();
          // Clear a stale cancelling phase that wasn't reached at shutdown.
          if (state.phase === "cancelling") state.phase = "active";
          await writeFile(stateFile, JSON.stringify(state, null, 2));
          console.log(`[pi-engineering] Run ${runId.slice(0, 8)} interrupted — marked paused. Resume with /run-resume ${runId}`);
        }
      } catch { /* no active run or already ended */ }
      console.log("[pi-engineering] Extension loaded. Run /run-start <workflow> \"<goal>\" to begin.");
    }
  });

  // Input hook: handles waiting_user phases for approval and freeform answering
  pi.on("input", async (event, ctx) => {
    const { readActiveRun, clearActiveRun } = await import("./adw/ActiveRun.js");
    const activeRun = await readActiveRun();
    if (!activeRun) return { action: "continue" as const };

    const text = event.text.trim();
    const lower = text.toLowerCase();

    // C1/L3: handle the discovery answering phase for spec-plan-build-review.
    // Any non-command message is captured as answers.md and the workflow resumes.
    if (activeRun.phase === "answering") {
      if (!text) {
        ctx.ui.notify("Reply with your discovery answers in one message, and I’ll save them to answers.md.", "info");
        return { action: "handled" as const };
      }
      if (text.startsWith("/")) {
        return { action: "continue" as const };
      }
      if (lower === "approve" || lower === "approved" || lower.includes("looks good")) {
        ctx.ui.notify("This step needs answers, not approval. Reply with your answers in one message.", "info");
        return { action: "handled" as const };
      }

      const { writeFile, mkdir } = await import("fs/promises");
      const answersPath = join(activeRun.runsDir, activeRun.runId, "answers.md");
      await mkdir(join(activeRun.runsDir, activeRun.runId), { recursive: true });
      await writeFile(answersPath, text);
      await clearActiveRun();
      ctx.ui.notify(`answers written → ${answersPath}\n\nRunning design…`, "info");

      engine.executeUntilPause(activeRun.runId)
        .then(async (state) => {
          if (state.status === "waiting_user") {
            const ar = await readActiveRun();
            if (ar?.stepName === "design") {
              ctx.ui.notify(
                `spec written → ${join(RUNS_DIR, activeRun.runId, "spec.md")}\n\nReview the spec, then type "approve" when ready to write the plan.`,
                "info",
              );
            } else if (ar?.stepName === "plan") {
              ctx.ui.notify(
                `plan written → ${join(RUNS_DIR, activeRun.runId, "plan.md")}\n\nReview the plan, then type "approve" when ready to build.`,
                "info",
              );
            }
          } else if (state.status === "succeeded") {
            ctx.ui.notify("✓ Workflow complete.", "info");
          } else if (state.status === "failed") {
            ctx.ui.notify(`Workflow stopped: step ${state.currentStep} failed.`, "error");
          }
        })
        .catch((err: unknown) => {
          ctx.ui.notify(
            `Workflow resume failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        });

      return { action: "handled" as const };
    }

    if (activeRun.phase !== "approving") return { action: "continue" as const };

    const isApproval = lower === "approve" || lower === "approved" || lower.includes("looks good");

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

    engine.executeUntilPause(runId)
      .then(async (state) => {
        if (state.status === "waiting_user") {
          const ar = await readActiveRun();
          if (ar?.stepName === "plan") {
            ctx.ui.notify(
              `plan written → ${join(RUNS_DIR, runId, "plan.md")}\n\nReview the plan, then type "approve" when ready to build.`,
              "info",
            );
          }
        } else if (state.status === "succeeded") {
          ctx.ui.notify("✓ Workflow complete.", "info");
        } else if (state.status === "failed") {
          ctx.ui.notify(`Workflow stopped: step ${state.currentStep} failed.`, "error");
        }
      })
      .catch((err: unknown) => {
        // H5: surface resume errors instead of silently discarding them
        ctx.ui.notify(
          `Workflow resume failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      });

    return { action: "handled" as const };
  });
}
