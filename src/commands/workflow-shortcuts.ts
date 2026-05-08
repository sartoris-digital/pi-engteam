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
      // Codex round-4 H-3: reject --rounds > 1 outright. The DAG engine does
      // not yet implement multi-round revision (deferred to Phase 4.5);
      // accepting a budget the workflow ignores misleads the user into
      // believing rounds=2 will re-orchestrate when it won't.
      if (parsed.rounds > 1) {
        ctx.ui.notify(
          `--rounds ${parsed.rounds} is not supported in v1. Multi-round consult ships in Phase 4.5. Re-run without --rounds (or --rounds 1).`,
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
      const wf = buildConsultWorkflow(parsed.teams, consultWorkflowName);
      engine.registerWorkflow(wf);

      const run = await engine.startRun({ workflow: wf.name, goal: parsed.topic, budget: {} });
      await bootstrapConsultRun(join(runsDir, run.runId));

      // Resolve selected short-names to long-form lead agent names for the
      // dispatch step prompt and any future resume-time filtering.
      const leadFor = (s: "eng" | "valid" | "invest"): string => {
        if (s === "eng") return "engineering-lead";
        if (s === "valid") return "validation-lead";
        return "investigation-lead";
      };
      const consultTeams: string[] = parsed.teams && parsed.teams.length > 0
        ? parsed.teams.map(leadFor)
        : ["engineering-lead", "validation-lead", "investigation-lead"];

      // M1: persist round budget on the run state for autopilot/UI surfacing.
      // Codex round-3 M: also persist consultTeams so the dispatch step's
      // prompt + any resume-time workflow rebuild see the user-selected
      // subset rather than defaulting to all three leads.
      const { loadRunState, saveRunState } = await import("../adw/RunState.js");
      const cur = await loadRunState(runsDir, run.runId);
      if (cur) {
        await saveRunState(runsDir, {
          ...cur,
          rounds: { current: 0, max: parsed.rounds },
          consultTeams,
        } as unknown as typeof cur);
      }

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
  let warning: string | undefined;

  const roundsMatch = s.match(/--rounds\s+(\d+)/);
  if (roundsMatch) {
    const requested = parseInt(roundsMatch[1], 10);
    // H1: rounds>1 is reserved for Phase 4.5 multi-round revision — accept the
    // budget so /run-status can surface intent, but warn that v1 only runs
    // round 1 (positions + adversarials + synthesis).
    if (Number.isFinite(requested) && requested > 1) {
      rounds = requested;
      warning = `--rounds ${requested} accepted as round budget; multi-round revision ships in Phase 4.5. v1 runs round 1 only.`;
    } else {
      rounds = Math.max(1, requested || 1);
    }
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
