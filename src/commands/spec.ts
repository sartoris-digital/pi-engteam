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
    notify: (message: string, type?: "info" | "error" | "warning") => void;
  };
};

export async function executeSpecWorkflow(
  engine: ADWEngine,
  runsDir: string,
  runId: string,
  ctx: UiContext,
  opts: { prefilledAnswersPath?: string; autoApprove?: boolean } = {},
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

  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });

  if (opts.prefilledAnswersPath) {
    // Headless / scripted path: caller supplied --answers <file>. Copy it
    // verbatim as answers.md and skip the TUI wizard so this command can
    // run from a non-interactive Pi context (e.g. /run-start consumers,
    // batch scripts, or automated end-to-end tests).
    let raw: string;
    try {
      raw = await readFile(opts.prefilledAnswersPath, "utf8");
    } catch (err) {
      ctx.ui.notify(
        `Could not read --answers ${opts.prefilledAnswersPath}: ${err instanceof Error ? err.message : String(err)}. Run aborted.`,
        "error",
      );
      await engine.abortRun(runId);
      return;
    }
    if (!raw.trim()) {
      ctx.ui.notify(`--answers file ${opts.prefilledAnswersPath} is empty. Run aborted.`, "error");
      await engine.abortRun(runId);
      return;
    }
    await writeFile(join(runDir, "answers.md"), raw);
    ctx.ui.notify(`answers loaded from ${opts.prefilledAnswersPath} (wizard skipped).`, "info");
  } else {
    // Interactive path: show the TUI wizard, write answers from the result.
    const answers = await ctx.ui.custom<Record<string, string[]>>(
      (tui, theme, _keybindings, done) => new QuestionWizard(tui, theme, categories, done),
      {
        overlay: true,
        overlayOptions: { width: "80%", maxHeight: "90%", anchor: "top-center", offsetY: 1 },
      },
    );
    await writeFile(join(runDir, "answers.md"), formatAnswers(answers, categories));
  }
  await clearActiveRun();

  // Phase 2: resume — runs until design step pauses awaiting approval
  await engine.executeUntilPause(runId);
  const specPath = join(runsDir, runId, "spec.md");

  if (!opts.autoApprove) {
    ctx.ui.notify(
      `spec written → ${specPath}\n\nReview the spec, then type "approve" when ready to write the plan.`,
      "info",
    );
    // Command returns. The input hook in index.ts takes over for subsequent
    // approval phases (one "approve" per gate).
    return;
  }

  // --auto-approve: skip the design + plan approval gates entirely. The
  // workflow then runs straight through build and review to terminal. This
  // is intentionally only opt-in — by default we keep the human in the
  // loop because spec/plan errors compound.
  ctx.ui.notify(`spec written → ${specPath}\nAuto-approved (--auto-approve). Running plan…`, "info");
  await engine.executeUntilPause(runId);

  const planPath = join(runsDir, runId, "plan.md");
  ctx.ui.notify(`plan written → ${planPath}\nAuto-approved. Running build → review…`, "info");
  await engine.executeUntilPause(runId);

  // After plan's approve gate, the workflow has build + review steps with no
  // further pauseAfter — executeUntilPause runs to terminal. Surface the
  // final status so the caller sees the outcome.
  const final = await engine.executeUntilPause(runId);
  ctx.ui.notify(`Run ${runId.slice(0, 8)} finished: ${final.status}`, final.status === "succeeded" ? "info" : "error");
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
      'Discover requirements, write spec and plan, then build and review. Usage: /spec <goal> [--answers <path>] [--auto-approve]',
    handler: async (args, ctx) => {
      // --answers <path> bypasses the TUI wizard with pre-supplied answers.
      // --auto-approve skips the design + plan approval gates so the run
      // continues straight through to build and review without human input
      // — required for fully unattended end-to-end testing.
      let goal = args;
      let prefilledAnswersPath: string | undefined;
      const answersMatch = goal.match(/--answers\s+(\S+)/);
      if (answersMatch) {
        prefilledAnswersPath = answersMatch[1];
        goal = goal.replace(answersMatch[0], "").trim();
      }
      let autoApprove = false;
      if (/(^|\s)--auto-approve(\s|$)/.test(goal)) {
        autoApprove = true;
        goal = goal.replace(/(^|\s)--auto-approve(\s|$)/, " ").trim();
      }
      goal = goal.trim();
      if (!goal) {
        ctx.ui.notify(
          'Usage: /spec <goal in plain English> [--answers <path>] [--auto-approve]\nExample: /spec "Add dark mode toggle to settings"\nHeadless: /spec "<goal>" --answers /tmp/answers.md --auto-approve',
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

      const flags: string[] = [];
      if (prefilledAnswersPath) flags.push(`answers=${prefilledAnswersPath}`);
      if (autoApprove) flags.push("auto-approve");
      ctx.ui.notify(
        `▶ spec-plan-build-review started (run ${run.runId.slice(0, 8)})\nGoal: ${goal}\n${flags.length ? `Flags: ${flags.join(", ")}` : "Discovering requirements…"}`,
        "info",
      );

      await executeSpecWorkflow(engine, runsDir, run.runId, ctx, { prefilledAnswersPath, autoApprove });
    },
  });
}
