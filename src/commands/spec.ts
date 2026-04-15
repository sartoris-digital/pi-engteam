import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { AgentDefinition } from "../types.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { clearActiveRun } from "../adw/ActiveRun.js";
import { QuestionWizard } from "../ui/QuestionWizard.js";
import { parseQuestionsFile, formatAnswers } from "./spec-utils.js";

type UiContext = {
  ui: {
    custom: <T>(
      factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
      options?: any,
    ) => Promise<T>;
    notify: (message: string, type: "info" | "error" | "warning" | "success") => void;
  };
};

export async function executeSpecWorkflow(
  engine: ADWEngine,
  runsDir: string,
  runId: string,
  ctx: UiContext,
): Promise<void> {
  // Phase 1: run until discover step pauses awaiting wizard input
  await engine.executeUntilPause(runId);

  const questionsPath = join(runsDir, runId, "questions.md");
  let questionsRaw: string;
  try {
    questionsRaw = await readFile(questionsPath, "utf8");
  } catch {
    ctx.ui.notify("Discoverer did not write questions.md. Run aborted.", "error");
    await engine.abortRun(runId);
    return;
  }

  const categories = parseQuestionsFile(questionsRaw);
  if (categories.length === 0) {
    ctx.ui.notify("No questions found in questions.md. Run aborted.", "error");
    await engine.abortRun(runId);
    return;
  }

  // Show TUI wizard — blocks until user submits
  const answers = await ctx.ui.custom<Record<string, string[]>>(
    (tui, theme, _keybindings, done) => new QuestionWizard(tui, theme, categories, done),
    {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "90%", anchor: "top-center", offsetY: 1 },
    },
  );

  // Write answers.md
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "answers.md"), formatAnswers(answers, categories));
  await clearActiveRun();

  // Phase 2: resume — runs until design step pauses awaiting approval
  await engine.executeUntilPause(runId);

  const specPath = join(runsDir, runId, "spec.md");
  ctx.ui.notify(
    `spec written → ${specPath}\n\nReview the spec, then type "approve" when ready to write the plan.`,
    "info",
  );
  // Command returns. The input hook in index.ts takes over for subsequent approval phases.
}

export function registerSpecCommand(
  pi: ExtensionAPI,
  engine: ADWEngine,
  team: TeamRuntime,
  agentDefs: AgentDefinition[],
  runsDir: string,
): void {
  pi.registerCommand("spec", {
    description:
      "Discover requirements, write spec and plan, then build and review. Usage: /spec <goal>",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify(
          'Usage: /spec <goal in plain English>\nExample: /spec "Add dark mode toggle to settings"',
          "error",
        );
        return;
      }

      for (const def of agentDefs) {
        await team.ensureTeammate(def.name, def);
      }

      const run = await engine.startRun({
        workflow: "spec-plan-build-review",
        goal,
        budget: {},
      });

      ctx.ui.notify(
        `▶ spec-plan-build-review started (run ${run.runId.slice(0, 8)})\nGoal: ${goal}\nDiscovering requirements…`,
        "info",
      );

      await executeSpecWorkflow(engine, runsDir, run.runId, ctx);
    },
  });
}
