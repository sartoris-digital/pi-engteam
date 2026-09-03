import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { refToString } from "../trackers/adapter.js";
import {
  probeChecks,
  probeGit,
  probeDefaultBranch,
  probePackageManager,
  probeSandbox,
} from "../setup/probes.js";
import { readAnswersFile, runGlobalInterview, runRepoInterview, type SetupUi } from "../setup/interview.js";
import { writeGlobalConfig, writeRepoConfig } from "../setup/writers.js";
import { runApprove } from "./approve.js";
import { runClosed } from "./closed.js";
import { completeFactoryArgs, type AutocompleteItem, type CompletionDeps } from "./completions.js";
import { readQueue, runEnqueue } from "./enqueue.js";
import { runLanded } from "./landed.js";
import { runReconcile } from "./reconcile.js";
import { parseFactoryArgs } from "./router.js";
import { runStart } from "./start.js";
import { runStatus } from "./status.js";

export interface RegisteredCommands {
  /** Re-reads the queue into the synchronous completion snapshot. */
  refresh: () => Promise<void>;
}

export async function completionSnapshot(deps: FactoryDeps): Promise<CompletionDeps> {
  const queue = await readQueue(deps.runsDir);
  return {
    lanes: Object.keys(deps.lanes),
    repos: deps.repos,
    runs: queue.entries
      .filter((entry) => entry.runId !== undefined)
      .map((entry) => ({
        ref: entry.ref,
        runId: entry.runId ?? "",
        lane: entry.lane ?? entry.kind,
        status: entry.state === "published" ? "succeeded" : entry.state,
      })),
  };
}

function setupUiFrom(ui: ExtensionCommandContext["ui"]): SetupUi {
  return {
    select: (title, options) => ui.select(title, options),
    input: (title, placeholder) => ui.input(title, placeholder),
    confirm: async (title, initial = true) => ui.confirm(title, initial ? "yes" : "no"),
  };
}

async function handleSetup(
  args: ReturnType<typeof parseFactoryArgs>,
  deps: FactoryDeps,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const answersFlag = args.flags["answers"];
  const answers = typeof answersFlag === "string" ? await readAnswersFile(answersFlag) : undefined;
  const repo = args.args[0];
  const ui = setupUiFrom(ctx.ui);
  if (repo === undefined) {
    const result = await runGlobalInterview(ui, {
      probes: { sandbox: await probeSandbox() },
      ...(answers === undefined ? {} : { answers }),
    });
    const path = await writeGlobalConfig(deps.home, result.diff);
    return `global config written to ${path}`;
  }
  const result = await runRepoInterview(ui, repo, {
    probes: {
      git: await probeGit(repo),
      defaultBranch: await probeDefaultBranch(repo),
      packageManager: await probePackageManager(repo),
      checks: await probeChecks(repo),
    },
    ...(answers === undefined ? {} : { answers }),
  });
  const path = await writeRepoConfig(repo, result.diff, { local: true });
  return `repo overlay written to ${path}`;
}

export function registerCommands(pi: ExtensionAPI, deps: FactoryDeps): RegisteredCommands {
  let snapshot: CompletionDeps = { lanes: Object.keys(deps.lanes), repos: deps.repos, runs: [] };
  const refresh = async (): Promise<void> => {
    try {
      snapshot = await completionSnapshot(deps);
    } catch {
      // keep the last good snapshot; completions must never throw at the prompt
    }
  };

  pi.registerCommand("factory", {
    description: "Software factory — type a space to list subcommands",
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null =>
      completeFactoryArgs(argumentPrefix, snapshot),
    handler: async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parsed = parseFactoryArgs(rawArgs);
      if (parsed.verb === null) {
        ctx.ui.notify(`/factory: ${parsed.error ?? "bad arguments"}`, "error");
        return;
      }
      try {
        switch (parsed.verb) {
          case "setup":
            ctx.ui.notify(await handleSetup(parsed, deps, ctx), "info");
            return;
          case "enqueue": {
            const { ticket } = await runEnqueue(parsed, deps);
            ctx.ui.notify(`queued ${refToString(ticket.ref)}: ${ticket.title}`, "info");
            if (parsed.flags.now === true) {
              const states = await runStart(parsed, deps);
              ctx.ui.notify(`/factory start: ${states.length} run(s) drained`, "info");
            }
            return;
          }
          case "start": {
            const states = await runStart(parsed, deps);
            ctx.ui.notify(`/factory start: ${states.length} run(s) drained`, "info");
            return;
          }
          case "approve": {
            const state = await runApprove(parsed, deps);
            ctx.ui.notify(`${state.ticket.ref} resumed → ${state.status}`, "info");
            return;
          }
          case "status":
            ctx.ui.notify(await runStatus(parsed, deps), "info");
            return;
          case "landed": {
            const entry = await runLanded(parsed, deps);
            ctx.ui.notify(`${entry.ref} landed (${entry.landedAs ?? "clean"})`, "info");
            return;
          }
          case "closed": {
            const entry = await runClosed(parsed, deps);
            ctx.ui.notify(`${entry.ref} closed`, "info");
            return;
          }
          case "reconcile": {
            const updated = await runReconcile(parsed, deps);
            ctx.ui.notify(`/factory reconcile: ${updated.length} published entry(ies)`, "info");
            return;
          }
        }
      } catch (error) {
        ctx.ui.notify(`/factory ${parsed.verb}: ${String(error)}`, "error");
      } finally {
        await refresh();
      }
    },
  });

  return { refresh };
}

export { runRemember } from "./remember.js";
export { runRules } from "./rules.js";
export { runForget } from "./forget.js";
export { runGrill } from "./grill.js";

