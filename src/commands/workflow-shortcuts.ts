import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";

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
    "pi-engteam workflows — run any with /<command> <goal in plain English>",
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
    "  • /engteam-doctor      — check installation health",
  ].join("\n");
}

export function registerWorkflowShortcuts(pi: ExtensionAPI, engine: ADWEngine): void {
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
        void engine.executeRun(run.runId);

        ctx.ui.notify(
          [
            `▶ ${workflow} started (run ${run.runId.slice(0, 8)})`,
            `Goal: ${goal}`,
            ``,
            `Watch progress:`,
            `  /run-status ${run.runId}`,
            `  /observe  (dashboard at http://127.0.0.1:4747)`,
            `  tail -f ~/.pi/engteam/runs/${run.runId}/events.jsonl`,
          ].join("\n"),
          "info",
        );
      },
    });
  }

  // /workflows — list all available workflows with examples
  pi.registerCommand("workflows", {
    description: "List all available pi-engteam workflows with example usage",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatWorkflowHelp(), "info");
    },
  });
}
