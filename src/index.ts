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
import { registerIssueCommand } from "./commands/issue.js";
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
import { registerRunStartCommand } from "./commands/run-start.js";
import { registerRunResumeCommand } from "./commands/run-resume.js";
import { registerRunAbortCommand } from "./commands/run-abort.js";
import { registerRunPlanModeCommand } from "./commands/run-plan-mode.js";
import { registerRunStatusCommand } from "./commands/run-status.js";
import { loadMemoryConfig } from "./memory/config.js";
import { MemoryCore } from "./memory/MemoryCore.js";
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

const AGENT_DEFS: AgentDefinition[] = [
  {
    name: "planner",
    description: "Orchestrator — decomposes goals, sequences work, produces plans",
    model: "claude-opus-4.6",
    systemPrompt:
      "You are the Planner agent for the pi-engineering engineering team. " +
      "Decompose the given goal into actionable sub-tasks, identify the specialist agents needed, " +
      "and produce a clear implementation plan. Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "implementer",
    description: "Writes production code and tests per the plan",
    model: "claude-sonnet-4.6",
    systemPrompt:
      "You are the Implementer agent for the pi-engineering engineering team. " +
      "Read the plan and implement it step by step. Write tests alongside code (TDD). " +
      "For any destructive operation (git push, package install, file delete), call RequestApproval first. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "reviewer",
    description: "Deep code inspection for correctness, maintainability, and regressions",
    model: "claude-opus-4.6",
    systemPrompt:
      "You are the Reviewer agent for the pi-engineering engineering team. " +
      "Carefully read all changed code. Check for logical errors, missing tests, security issues, " +
      "and regression risk. Be specific about any problems — name file, line, and what is wrong. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "discoverer",
    description: "Generates discovery questions to understand feature requirements before spec writing",
    model: "claude-haiku-4.5",
    systemPrompt:
      "You are the Discoverer agent for the pi-engineering engineering team. " +
      "Analyze the feature goal and write 3-5 focused discovery questions in a questions.md file. " +
      "Categories must be exactly: SCOPE, CONSTRAINTS, SUCCESS, CONTEXT. " +
      "Use numbered lists under each ## heading. Keep each question to one sentence. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "architect",
    description: "Writes feature specifications from goals and answered discovery questions",
    model: "claude-opus-4.6",
    systemPrompt:
      "You are the Architect agent for the pi-engineering engineering team. " +
      "Read the discovery answers and write a precise, complete feature specification in spec.md. " +
      "Use the ADR-style sections: Problem, Approach, Acceptance Criteria, Key Interfaces, Out of Scope, Open Questions. " +
      "Be specific — no padding or vague statements. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "issue-analyst",
    description: "Fetches issue tickets from GitHub, ADO, or Jira CLIs and extracts structured requirements",
    model: "claude-haiku-4.5",
    systemPrompt:
      "You are the Issue Analyst agent for the pi-engineering engineering team. " +
      "Read the goal to get the ticket reference and tracker type. " +
      "Fetch the ticket using the appropriate pre-authenticated CLI (gh, az, or jira). " +
      "Extract the requirements and write issue-brief.md with all required sections. " +
      "Select the appropriate downstream workflow based on issue type. " +
      "Always call VerdictEmit at the end of your turn with step='analyze'.",
  },
  {
    name: "root-cause-debugger",
    description: "Deep code-path analysis using competing-hypothesis investigation",
    model: "claude-opus-4.6",
    systemPrompt:
      "You are the Root Cause Debugger agent for the pi-engineering engineering team. " +
      "Use a seven-stage competing-hypothesis protocol: Observe → Hypothesize (≥2 competing causes) → Gather evidence for each → Rebuttal round → Rank by evidence weight → Synthesize → Probe to close gaps. " +
      "Trace failures to file:line. Produce a fix-plan.md with ranked fix options and rollback plans. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "tester",
    description: "Creates unit, integration, and regression tests. Validates fixes.",
    model: "claude-sonnet-4.6",
    systemPrompt:
      "You are the Tester agent for the pi-engineering engineering team. " +
      "Write the failing test first, verify it fails, then validate the fix makes it pass. " +
      "Use vitest and follow patterns in tests/unit/ and tests/integration/. " +
      "Run pnpm test to confirm 0 failures before calling VerdictEmit. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "judge",
    description: "Final verdict authority. Signs approval tokens for sensitive operations.",
    model: "claude-opus-4.6",
    systemPrompt:
      "You are the Judge agent for the pi-engineering engineering team. " +
      "You are the final gate before a workflow completes or a sensitive operation executes. " +
      "Before voting PASS: run git diff to see what changed, confirm test output shows 0 failures, verify all reviewer issues are addressed, and confirm the implementation matches the stated goal. " +
      "You are the only agent authorized to call GrantApproval. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "knowledge-retriever",
    description: "Fetches and summarizes relevant code, docs, ADRs, and tickets for other agents",
    model: "claude-sonnet-4.6",
    systemPrompt:
      "You are the Knowledge Retriever agent for the pi-engineering engineering team. " +
      "Search the codebase, docs, and ADR directories for content relevant to the stated goal. " +
      "Summarize findings into a context-pack.md with grounded, project-specific context. Explicitly state what you could not find. " +
      "Check file size before reading; cap parallel reads at 5 files per round. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "incident-investigator",
    description: "Pulls logs, traces, metrics; builds competing-hypothesis probable-cause tree for incidents",
    model: "claude-opus-4.6",
    systemPrompt:
      "You are the Incident Investigator agent for the pi-engineering engineering team. " +
      "Use a seven-stage competing-hypothesis protocol: Observe → Hypothesize (≥2 competing causes) → Gather evidence for each → Rebuttal round → Rank by evidence weight → Synthesize → Probe to close gaps. " +
      "Pull from events.jsonl, metrics, logs, and recent commits. Include a Timeline section in your report. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "bug-triage",
    description: "Classifies bugs, assigns severity P0–P3, routes to the right owner",
    model: "claude-haiku-4.5",
    systemPrompt:
      "You are the Bug Triage agent for the pi-engineering engineering team. " +
      "Read the bug report, search the codebase for the likely defect location, check for duplicate reports, " +
      "assign severity (P0 critical / P1 high / P2 medium / P3 low), determine the responsible owner area, " +
      "and write a triage summary in verdict.md. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "security-auditor",
    description: "Static analysis, secrets scanning, auth and dependency review",
    model: "claude-opus-4.6",
    systemPrompt:
      "You are the Security Auditor agent for the pi-engineering engineering team. " +
      "Scan changed files for insecure patterns (injection, hardcoded secrets, missing auth checks), " +
      "check dependencies for CVEs via pnpm audit, and review auth and permission boundaries. " +
      "Write security-report.md with all findings classified by severity. You are read-only — report only, never patch. " +
      "If you find Critical or High severity issues you MUST emit FAIL. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "codebase-cartographer",
    description: "Maps modules, dependencies, conventions, and risk areas before significant changes",
    model: "claude-sonnet-4.6",
    systemPrompt:
      "You are the Codebase Cartographer agent for the pi-engineering engineering team. " +
      "Map the modules and files relevant to the stated goal, identify dependency chains and integration points, " +
      "find existing conventions (naming, error handling, test patterns), and flag hotspots. " +
      "Write codebase-map.md summarizing your findings. Check file size before reading; cap parallel reads at 5 files per round. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "observability-archivist",
    description: "Reads event streams, builds trace timelines, identifies patterns and anomalies",
    model: "claude-sonnet-4.6",
    systemPrompt:
      "You are the Observability Archivist agent for the pi-engineering engineering team. " +
      "Read the event stream from ~/.pi/engineering-team/runs/{runId}/events.jsonl. " +
      "Build a trace timeline, identify slow steps and frequent failures, and surface anomalies. " +
      "Write observation-report.md with a timeline, performance breakdown, and actionable insights. " +
      "Always call VerdictEmit at the end of your turn.",
  },
];

export default async function (pi: ExtensionAPI) {
  // ── Agent subprocess mode ──────────────────────────────────────────────────
  // When PI_ENGINEERING_AGENT_MODE=1, this extension is loaded inside a pi subprocess
  // spawned by TeamRuntime.deliver(). Register agent-facing tools only — skip all
  // controller infrastructure (server, observer, commands, TeamRuntime).
  if (process.env["PI_ENGINEERING_AGENT_MODE"]) {
    // C2: apply Layer A hard blockers in subprocess mode so agents can't run
    // dangerous rm, force-push, sudo, or device-writes even without the full guard.
    registerHardBlockers(pi, { hardBlockers: { enabled: true, alwaysOn: true } });

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
      const subResolver = createSecretResolver({
        vault: subVault,
        emitEvent: () => { /* no-op in subprocess; controller-side observer not available */ },
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
  const memoryConfig = await loadMemoryConfig();
  const memoryCore = new MemoryCore(memoryConfig, RUNS_DIR);

  registerSafetyGuard(pi, { ...safetyConfig, runsDir: RUNS_DIR });

  const writer = new EventWriter(RUNS_DIR);
  const sinkUrl = process.env.PI_ENGINEERING_EVENT_URL;
  const sink = sinkUrl ? new HttpSink(sinkUrl, "global", RUNS_DIR) : undefined;
  const observer = new Observer(writer, sink);

  const bus = new MessageBus();

  let activeRunId = "none";

  const team = new TeamRuntime({
    cwd: process.cwd(),
    bus,
    observer,
    runsDir: RUNS_DIR,
    agentDefs: AGENT_DEFS,
    // H2: onVerdictReceived replaces the dead customToolsFor pattern.
    // TeamRuntime.deliver() calls this after reading the subprocess verdict file,
    // giving the host access to learnings/decisions/gotchas before they are stripped.
    onVerdictReceived: (runId, agentName, verdict) => {
      memoryCore.onVerdict(runId, verdict);
      observer.emit({
        runId,
        agentName,
        category: "verdict",
        type: "emit",
        payload: verdict,
        summary: `${agentName}: ${verdict.verdict} on ${verdict.step}`,
      });
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
  ]);
  const engine = new ADWEngine({ runsDir: RUNS_DIR, workflows, team, observer });

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
  registerWorkflowShortcuts(pi, engine);
  registerSpecCommand(pi, engine, team, AGENT_DEFS, RUNS_DIR);
  registerIssueCommand(pi, engine, team, AGENT_DEFS, RUNS_DIR);
  registerRunStartCommand(pi, engine);
  registerRunResumeCommand(pi, engine);
  registerRunAbortCommand(pi, engine);
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
  void rateLimitGuard;

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
      // Cleanup: mark any lingering "running" runs as aborted so plan mode doesn't persist after restarts
      try {
        const { readFile, writeFile } = await import("fs/promises");
        const { join } = await import("path");
        const activeFile = join(RUNS_DIR, "active-run.txt");
        const runId = (await readFile(activeFile, "utf8")).trim();
        const stateFile = join(RUNS_DIR, runId, "state.json");
        const state = JSON.parse(await readFile(stateFile, "utf8"));
        if (state.status === "running" || state.status === "waiting_user") {
          state.status = "aborted";
          state.updatedAt = new Date().toISOString();
          await writeFile(stateFile, JSON.stringify(state, null, 2));
          console.log(`[pi-engineering] Cleaned up stale run ${runId.slice(0, 8)} (was ${state.status})`);
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
