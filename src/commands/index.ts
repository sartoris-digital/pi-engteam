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
import { runDoctor } from "./doctor.js";
import { completeFactoryArgs, type AutocompleteItem, type CompletionDeps } from "./completions.js";
import { readQueue, runEnqueue } from "./enqueue.js";
import { runForget } from "./forget.js";
import { runGrant } from "./grant.js";
import { runGrill } from "./grill.js";
import { runLanded } from "./landed.js";
import { runReconcile } from "./reconcile.js";
import { runRemember } from "./remember.js";
import { parseFactoryArgs, type FactoryVerb } from "./router.js";
import { runRules } from "./rules.js";
import { runSecret } from "./secret.js";
import { runStart } from "./start.js";
import { runStatus } from "./status.js";

export interface RegisteredCommands {
  /** Re-reads the queue into the synchronous completion snapshot. */
  refresh: () => Promise<void>;
}

function snapshotExtra(entry: object): { waitingOn?: string; escalations?: Array<{ code: string }> } {
  return entry as { waitingOn?: string; escalations?: Array<{ code: string }> };
}

function snapshotStatus(entry: { state: string }): string {
  const extra = snapshotExtra(entry);
  if (entry.state === "waiting_user") return "awaiting-steer";
  if (entry.state === "published") return "succeeded";
  if (entry.state === "blocked" && (extra.waitingOn === "approval" || extra.escalations?.some((e) => e.code === "approval-needed"))) {
    return "approval-needed";
  }
  const last = extra.escalations?.[extra.escalations.length - 1]?.code;
  if (last === "approval-needed") return "approval-needed";
  return entry.state;
}

export async function completionSnapshot(deps: FactoryDeps): Promise<CompletionDeps> {
  const queue = await readQueue(deps.runsDir);
  let secretNames: string[] = [];
  try {
    secretNames = (await deps.vault?.list())?.map((m) => m.name) ?? [];
  } catch {
    secretNames = [];
  }
  return {
    lanes: Object.keys(deps.lanes),
    repos: deps.repos,
    secretNames,
    runs: queue.entries
      .filter((entry) => entry.runId !== undefined)
      .map((entry) => {
        const extra = snapshotExtra(entry);
        const lastCode = extra.escalations?.[extra.escalations.length - 1]?.code;
        return {
          ref: entry.ref,
          runId: entry.runId ?? "",
          lane: entry.lane ?? entry.kind ?? "",
          status: snapshotStatus(entry),
          ...(extra.waitingOn === undefined ? {} : { waitingOn: extra.waitingOn }),
          ...(lastCode === undefined ? {} : { escalation: lastCode }),
        };
      }),
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
        for (const message of await dispatchFactoryVerb(parsed.verb, parsed, deps, ctx)) {
          ctx.ui.notify(message.text, message.level);
        }
        return;
      } catch (error) {
        ctx.ui.notify(`/factory ${parsed.verb}: ${String(error)}`, "error");
      } finally {
        await refresh();
      }
    },
  });

  return { refresh };
}

type Notify = { text: string; level: "info" | "error" };

function notImplemented(verb: FactoryVerb): Notify[] {
  return [{ text: `/factory ${verb}: not implemented`, level: "error" }];
}

function info(text: string): Notify[] {
  return [{ text, level: "info" }];
}

async function dispatchFactoryVerb(
  verb: FactoryVerb,
  parsed: ReturnType<typeof parseFactoryArgs>,
  deps: FactoryDeps,
  ctx: ExtensionCommandContext,
): Promise<Notify[]> {
  switch (verb) {
    case "setup":
      return info(await handleSetup(parsed, deps, ctx));
    case "enqueue": {
      const { ticket } = await runEnqueue(parsed, deps);
      const notes = info(`queued ${refToString(ticket.ref)}: ${ticket.title}`);
      if (parsed.flags.now !== true) return notes;
      const states = await runStart(parsed, deps);
      return [...notes, { text: `/factory start: ${states.length} run(s) drained`, level: "info" }];
    }
    case "start": {
      const states = await runStart(parsed, deps);
      return info(`/factory start: ${states.length} run(s) drained`);
    }
    case "approve": {
      const state = await runApprove(parsed, deps);
      return info(`${state.ticket.ref} resumed → ${state.status}`);
    }
    case "status":
      return info(await runStatus(parsed, deps));
    case "landed": {
      const entry = await runLanded(parsed, deps);
      return info(`${entry.ref} landed (${entry.landedAs ?? "clean"})`);
    }
    case "closed": {
      const entry = await runClosed(parsed, deps);
      return info(`${entry.ref} closed`);
    }
    case "reconcile": {
      const updated = await runReconcile(parsed, deps);
      return info(`/factory reconcile: ${updated.length} published entry(ies)`);
    }
    case "remember": {
      const rule = await runRemember(parsed, deps);
      return info(`remembered ${rule.id}`);
    }
    case "rules":
      return info(await runRules(parsed, deps));
    case "forget": {
      const rule = await runForget(parsed, deps);
      return info(`retired ${rule.id}`);
    }
    case "grill": {
      const { ticket } = await runGrill(parsed, deps);
      return info(`grilled ${refToString(ticket.ref)}: ${ticket.title}`);
    }
    case "grant": {
      const state = await runGrant(parsed, deps, ctx);
      return info(`${state.runId} granted → ${state.status}`);
    }
    case "secret":
      return info(await runSecret(parsed, deps));
    case "doctor": {
      const text = await runDoctor(deps, parsed);
      return info(typeof text === "string" ? text : JSON.stringify(text));
    }
    case "config":
    case "lanes":
    case "watch":
    case "interrupt":
    case "stop":
    case "classify":
    case "resume":
    case "replan":
    case "cancel":
    case "drop":
    case "retry":
    case "rescan":
    case "gc":
    case "rebase":
      return notImplemented(verb);
  }
}

export { runRemember } from "./remember.js";
export { runRules } from "./rules.js";
export { runForget } from "./forget.js";
export { runGrill } from "./grill.js";
export { runGrant } from "./grant.js";
export { runSecret } from "./secret.js";
export { runDoctor } from "./doctor.js";

