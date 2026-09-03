import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { runCancel } from "./cancel.js";
import { runClassify } from "./classify.js";
import { runClosed } from "./closed.js";
import { runCodified } from "./codified.js";
import { runCodify } from "./codify.js";
import { runDoctor } from "./doctor.js";
import { completeFactoryArgs, type AutocompleteItem, type CompletionDeps } from "./completions.js";
import { runDrop } from "./drop.js";
import { readQueue, runEnqueue } from "./enqueue.js";
import { runForget } from "./forget.js";
import { runGc } from "./gc.js";
import { runGrant } from "./grant.js";
import { runGrill } from "./grill.js";
import { runLanded } from "./landed.js";
import { runReconcile } from "./reconcile.js";
import { runRemember } from "./remember.js";
import { runRebase } from "./rebase.js";
import { runReplan } from "./replan.js";
import { runRescan } from "./rescan.js";
import { runResume } from "./resume.js";
import { runRetry } from "./retry.js";
import { parseFactoryArgs, type FactoryVerb } from "./router.js";
import { runRules } from "./rules.js";
import { runSecret } from "./secret.js";
import { runStart } from "./start.js";
import { runStatus } from "./status.js";
import { runStop } from "./stop.js";
import { runWatch } from "./watch.js";

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

async function unboundSeedNames(runsDir: string): Promise<string[]> {
  const dir = join(runsDir, "_factory", "codify", "seeds");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const unbound = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".manifest.json")) continue;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), "utf8")) as {
        placeholders?: string[];
        bindings?: Record<string, string>;
      };
      const bindings = rec.bindings ?? {};
      for (const ph of rec.placeholders ?? []) {
        if (bindings[ph] === undefined) unbound.add(ph);
      }
    } catch {
      /* skip */
    }
  }
  return [...unbound];
}

export async function completionSnapshot(deps: FactoryDeps): Promise<CompletionDeps> {
  const queue = await readQueue(deps.runsDir);
  let secretNames: string[] = [];
  try {
    secretNames = (await deps.vault?.list())?.map((m) => m.name) ?? [];
  } catch {
    secretNames = [];
  }
  const unboundNames = await unboundSeedNames(deps.runsDir);
  return {
    lanes: Object.keys(deps.lanes),
    repos: deps.repos,
    secretNames,
    unboundNames,
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
      return info(await runSecret(parsed, deps, ctx.ui));
    case "doctor": {
      const text = await runDoctor(deps, parsed);
      return info(typeof text === "string" ? text : JSON.stringify(text));
    }
    case "resume": {
      const state = await runResume(parsed, deps);
      return info(`${state.runId} resumed → ${state.status}`);
    }
    case "cancel": {
      const out = await runCancel(parsed, deps);
      return info(`${"runId" in out ? out.runId : out.ref} cancelled`);
    }
    case "drop": {
      const out = await runDrop(parsed, deps);
      return info(`${out.ref} dropped${out.removed ? " (worktree removed)" : ""}`);
    }
    case "retry": {
      const entry = await runRetry(parsed, deps);
      return info(`${entry.ref} requeued`);
    }
    case "rescan": {
      const out = await runRescan(parsed, deps);
      return info(`/factory rescan: claimed ${out.claimed}, skipped ${out.skipped}`);
    }
    case "gc": {
      const out = await runGc(parsed, deps);
      return info(`/factory gc: removed ${out.removed} worktree(s)`);
    }
    case "classify": {
      const entry = await runClassify(parsed, deps);
      return info(`${entry.ref} classified as ${entry.kind}`);
    }
    case "replan": {
      const state = await runReplan(parsed, deps);
      return info(`${state.runId} replan → ${state.status}`);
    }
    case "stop":
      return info(await runStop(parsed, deps));
    case "watch":
      return info(await runWatch(parsed, deps));
    case "rebase": {
      const entry = await runRebase(parsed, deps);
      return info(`${entry.ref} rebased → ${entry.workspace?.branch ?? entry.state}`);
    }
    case "codify":
      return info(await runCodify(parsed, deps));
    case "codified":
      return info(await runCodified(parsed, deps, ctx));
    case "config":
    case "lanes":
    case "interrupt":
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
export { runResume } from "./resume.js";
export { runCancel } from "./cancel.js";
export { runDrop } from "./drop.js";
export { runRetry } from "./retry.js";
export { runRescan } from "./rescan.js";
export { runGc } from "./gc.js";
export { runClassify } from "./classify.js";
export { runRebase } from "./rebase.js";
export { runReplan } from "./replan.js";
export { runStop } from "./stop.js";
export { runWatch } from "./watch.js";
export { runCodify } from "./codify.js";
export { runCodified } from "./codified.js";

