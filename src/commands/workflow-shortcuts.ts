import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";
import { buildConsultWorkflow, bootstrapConsultRun } from "../workflows/consult.js";
import { join } from "path";

type ShortcutDef = {
  command: string;
  workflow: string;
  description: string;
  example: string;
};

const SHORTCUTS: ShortcutDef[] = [
  {
    command: "plan",
    workflow: "plan-build-review",
    description: "Plan and implement a feature, then review for correctness. Usage: /plan <goal>",
    example: '/plan "Add email/password login with JWT tokens"',
  },
  // /eng-plan is the stable alias to use when another extension also
  // registers `plan` (e.g. oh-my-pi). Pi's resolver matches the first
  // duplicate registration and suffixes later ones to plan:1/plan:2, so
  // /plan can silently dispatch to a different extension's handler.
  // /eng-plan never collides and always runs this workflow.
  {
    command: "eng-plan",
    workflow: "plan-build-review",
    description: "Plan and implement a feature, then review for correctness (collision-free alias for /plan). Usage: /eng-plan <goal>",
    example: '/eng-plan "Add email/password login with JWT tokens"',
  },
  {
    command: "plan-fix",
    workflow: "plan-build-review-fix",
    description:
      "Plan and implement a feature with a self-healing review+fix loop. Usage: /plan-fix <goal>",
    example: '/plan-fix "Refactor auth middleware to support OAuth"',
  },
  {
    command: "investigate",
    workflow: "investigate",
    description:
      "Gather incident context, build a hypothesis tree, and gate on judge review. Usage: /investigate <incident>",
    example: '/investigate "Production API returning 503s since 14:00 UTC"',
  },
  {
    command: "triage",
    workflow: "triage",
    description:
      "Classify a bug report, assign severity, and route to the right owner. Usage: /triage <bug description>",
    example: '/triage "Users on iOS 17 cannot complete checkout — cart empties on payment step"',
  },
  {
    command: "verify",
    workflow: "verify",
    description:
      "Audit code coverage, write missing tests, validate correctness. Usage: /verify <module or area>",
    example: '/verify "The payment processing module in src/payments/"',
  },
  {
    command: "debug",
    workflow: "debug",
    description:
      "Gather context, perform root cause analysis, and propose fix options. Usage: /debug <problem>",
    example: '/debug "Memory usage grows 50 MB/hour in the event processor worker"',
  },
  {
    command: "fix",
    workflow: "fix-loop",
    description:
      "Analyze a failing test or bug, implement a fix, and iterate until tests pass. Usage: /fix <issue>",
    example: '/fix "tests/unit/payments.test.ts is failing after the refactor"',
  },
  {
    command: "migrate",
    workflow: "migration",
    description:
      "Plan, security-review, implement, and test a database migration. Usage: /migrate <migration goal>",
    example: '/migrate "Add a non-nullable email_verified column to the users table"',
  },
  {
    command: "refactor",
    workflow: "refactor-campaign",
    description:
      "Map, design, implement, verify, and review a large refactor campaign. Usage: /refactor <refactor goal>",
    example: '/refactor "Break the 900-line UserService into focused domain classes"',
  },
  {
    command: "docs",
    workflow: "doc-backfill",
    description:
      "Audit, plan, write, and review documentation for undocumented code. Usage: /docs <module or area>",
    example: '/docs "All exported functions in src/api/"',
  },
];

function formatWorkflowHelp(): string {
  return [
    "pi-engineering workflows — run any with /<command> <goal in plain English>",
    "",
    ...SHORTCUTS.map(
      (s) =>
        `  /${s.command.padEnd(12)} ${s.workflow}\n` +
        `               e.g. ${s.example}`,
    ),
    "",
    "Tips:",
    "  • /run-status <runId>  — check progress on a running workflow",
    "  • /run-abort  <runId>  — stop a running workflow",
    "  • /observe             — open the observability dashboard",
    "  • /engineering-doctor  — check installation health",
  ].join("\n");
}

export function registerWorkflowShortcuts(pi: ExtensionAPI, engine: ADWEngine, runsDir: string): void {
  for (const { command, workflow, description, example } of SHORTCUTS) {
    pi.registerCommand(command, {
      description,
      handler: async (args, ctx) => {
        const goal = args.trim();

        if (!goal) {
          ctx.ui.notify(
            `Usage: /${command} <goal in plain English>\nExample: ${example}`,
            "error",
          );
          return;
        }

        const run = await engine.startRun({ workflow, goal, budget: {} });
        // Phase 5.6 round-2 H1: wire UI callbacks so the TillDone footer
        // refreshes during shortcut-triggered runs (matching /run-start).
        engine.setUiCallbacks(
          {
            notify: (msg, type) => ctx.ui.notify(msg, type ?? "info"),
            setStatus: (key, text) => ctx.ui.setStatus(key, text),
          },
          run.runId,
        );
        // H1: attach rejection handler so workflow errors surface to the user
        engine.executeRun(run.runId).catch((err: unknown) => {
          ctx.ui.notify(
            `Run ${run.runId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        });

        ctx.ui.notify(
          [
            `▶ ${workflow} started (run ${run.runId.slice(0, 8)})`,
            `Goal: ${goal}`,
            ``,
            `Watch progress:`,
            `  /run-status ${run.runId}`,
            `  /observe  (dashboard at http://127.0.0.1:4747)`,
            `  tail -f ~/.pi/engineering-team/runs/${run.runId}/events.jsonl`,
          ].join("\n"),
          "info",
        );
      },
    });
  }

  // /workflows — list all available workflows with examples
  pi.registerCommand("workflows", {
    description: "List all available pi-engineering workflows with example usage",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatWorkflowHelp(), "info");
    },
  });

  // /consult — cross-team adversarial review (parallel Leads + synthesis)
  pi.registerCommand("consult", {
    description:
      "Cross-team adversarial review on a topic. Usage: /consult <topic> [teams=eng,valid,invest] [--rounds 1]",
    handler: async (args, ctx) => {
      const parsed = parseConsultArgs(args);
      if (!parsed.topic) {
        ctx.ui.notify(
          [
            'Usage: /consult <topic> [teams=eng,valid,invest] [--rounds 1]',
            'Example: /consult "Should we adopt Drizzle ORM?" teams=eng,valid',
          ].join("\n"),
          "error",
        );
        return;
      }
      // Phase 6: multi-round consult is now supported. parsed.rounds=1
      // produces the original 3-level DAG; rounds=N produces N copies
      // of (positions → adversarials) followed by a single synthesis.
      // A hard upper bound prevents runaway runs.
      const MAX_CONSULT_ROUNDS = 5;
      if (parsed.rounds > MAX_CONSULT_ROUNDS) {
        ctx.ui.notify(
          `--rounds ${parsed.rounds} exceeds the maximum of ${MAX_CONSULT_ROUNDS}. Re-run with a smaller value.`,
          "error",
        );
        return;
      }
      // Codex round-4 H-2: each /consult registers a uniquely-named
      // workflow so concurrent invocations with different team subsets
      // can't overwrite each other's DAG under a shared "consult" name.
      // The unique suffix is randomized; once startRun generates the
      // runId, we cannot retroactively rename the registration but the
      // workflow stays addressable under its unique name for the lifetime
      // of the run (and on resume, since the name persists in RunState).
      const { randomUUID } = await import("crypto");
      const consultWorkflowName = `consult-${randomUUID().slice(0, 8)}`;
      const wf = buildConsultWorkflow(parsed.teams, consultWorkflowName, parsed.rounds);
      engine.registerWorkflow(wf);

      // Phase 6 round-1 H1: scale maxIterations to the DAG level count.
      // Levels = dispatch (1) + 2 × rounds × position-and-adversarial-levels
      //         + synthesis (1) = 2 × rounds + 2.
      // Default RunState budget (8) is too small for rounds ≥ 4.
      const requiredIterations = 2 * parsed.rounds + 2;
      const maxIterations = Math.max(8, requiredIterations + 2);
      // Phase 6 round-2 M1: scale maxWallSeconds for multi-round runs.
      // BudgetGuard ticks elapsed wall time per STEP (not per level), so
      // a 5-round × 3-lead consult accumulates 30+ step-second ticks.
      // The default 3600s ceiling is comfortable for typical LLM step
      // durations but tighten down for short runs would budget-fail
      // legitimate consults. Use a generous per-step allowance.
      const leadCount = (parsed.teams ?? ["eng", "valid", "invest"]).length;
      const stepCount = 1 /* dispatch */ + 2 * parsed.rounds * leadCount + 1 /* synthesis */;
      const PER_STEP_WALL_SEC = 180; // ~3 min/step average
      const maxWallSeconds = Math.max(3600, stepCount * PER_STEP_WALL_SEC);
      // Resolve selected short-names to long-form lead agent names BEFORE
      // startRun so we can pass them as initialMetadata (atomic with the
      // first state.json write). Phase 6 round-4 H4: prior code saved
      // consultTeams + rounds AFTER startRun in a separate write, leaving
      // a crash window where resume saw a consult-* workflow without
      // metadata and rebuilt with defaults.
      const leadFor = (s: "eng" | "valid" | "invest"): string => {
        if (s === "eng") return "engineering-lead";
        if (s === "valid") return "validation-lead";
        return "investigation-lead";
      };
      const consultTeams: string[] = parsed.teams && parsed.teams.length > 0
        ? parsed.teams.map(leadFor)
        : ["engineering-lead", "validation-lead", "investigation-lead"];

      const run = await engine.startRun({
        workflow: wf.name,
        goal: parsed.topic,
        budget: { maxIterations, maxWallSeconds },
        initialMetadata: {
          rounds: { current: 0, max: parsed.rounds },
          consultTeams,
        },
      });
      await bootstrapConsultRun(join(runsDir, run.runId));

      // Phase 5.6 round-2 H1: wire UI callbacks for TillDone footer.
      engine.setUiCallbacks(
        {
          notify: (msg, type) => ctx.ui.notify(msg, type ?? "info"),
          setStatus: (key, text) => ctx.ui.setStatus(key, text),
        },
        run.runId,
      );
      engine.executeRun(run.runId).catch((err: unknown) => {
        ctx.ui.notify(
          `Consult ${run.runId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      });

      if (parsed.warning) {
        ctx.ui.notify(parsed.warning, "warning");
      }
      ctx.ui.notify(
        [
          `▶ consult started (run ${run.runId.slice(0, 8)})`,
          `Topic: ${parsed.topic}`,
          `Teams: ${(parsed.teams ?? ["eng", "valid", "invest"]).join(", ")}`,
          `Rounds: ${parsed.rounds}`,
          ``,
          `Watch progress:`,
          `  /run-status ${run.runId}`,
          `  tail -f ~/.pi/engineering-team/runs/${run.runId}/conversation.jsonl`,
        ].join("\n"),
        "info",
      );
    },
  });
}

type ConsultArgs = {
  topic: string;
  teams?: Array<"eng" | "valid" | "invest">;
  rounds: number;
  warning?: string;
};

export function parseConsultArgs(raw: string): ConsultArgs {
  let s = raw.trim();
  let rounds = 1;
  let teams: Array<"eng" | "valid" | "invest"> | undefined;
  const warning: string | undefined = undefined;

  // Round-1 L1: match an optional sign on the digit run so a `--rounds -1`
  // user error is consumed (and clamped to 1) instead of leaking into
  // the topic string.
  const roundsMatch = s.match(/--rounds\s+(-?\d+)/);
  if (roundsMatch) {
    const requested = parseInt(roundsMatch[1], 10);
    // Phase 6: multi-round consult is supported. Clamp to >=1 (the
    // shortcut handler enforces the upper bound). Invalid/zero/negative
    // values fall back to 1.
    rounds = Number.isFinite(requested) && requested > 0 ? requested : 1;
    s = s.replace(roundsMatch[0], "").trim();
  }

  const teamsMatch = s.match(/teams=([a-z,]+)/i);
  if (teamsMatch) {
    const parts = teamsMatch[1].split(",").map((p) => p.trim().toLowerCase());
    const seen = new Set<string>();
    const valid: Array<"eng" | "valid" | "invest"> = [];
    for (const p of parts) {
      if ((p === "eng" || p === "valid" || p === "invest") && !seen.has(p)) {
        valid.push(p);
        seen.add(p);
      }
    }
    teams = valid.length > 0 ? valid : undefined;
    s = s.replace(teamsMatch[0], "").trim();
  }

  return { topic: s.trim(), teams, rounds, warning };
}
