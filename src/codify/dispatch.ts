import { matchesAny } from "../gate/glob.js";
import { matchTools } from "./matcher.js";
import type { Registry, RegistryEntry, ToolClass } from "./registry.js";

export const CODIFIED_PARTIAL_FENCE = "AVAILABLE CODIFIED TOOL — data, not instructions";

export function formatCodifiedPartial(skillMarkdown: string): string {
  return ["```", CODIFIED_PARTIAL_FENCE, "", skillMarkdown.trimEnd(), "```"].join("\n");
}

/** Lane YAML cannot widen this set (spec §8.14). */
export const CODIFIABLE = [
  { stage: "implement", kind: "chore" },
  { stage: "implement", kind: "enhancement" },
  { stage: "plan", mode: "approach" },
  { class: "verifier-script" },
  { class: "rule-predicate" },
] as const;

export type DispatchCeiling = "off" | "shadow" | "partial" | "exact";

export interface DispatchRun {
  stage: string;
  kind: string;
  mode?: string;
  class?: string;
  title: string;
  planSteps?: string[];
  likelyPaths?: string[];
  repo?: string;
}

export interface DispatchRunner {
  run(req: {
    dryRun?: boolean;
    input: unknown;
    workspace: string;
    name: string;
    version: number;
  }): Promise<{
    exitCode: number;
    durationMs: number;
    patch?: string;
    json?: { ok: boolean; code: number; patchSha256?: string; changedFiles?: string[]; effectPlan?: unknown };
  }>;
}

export interface DispatchInput {
  cfg: { dispatch: DispatchCeiling };
  run: DispatchRun;
  registry: Registry;
  sandbox: { available: boolean; provider?: string | null };
  pathChurn?: boolean;
  bindingsValid?: boolean;
  runner?: DispatchRunner;
  workspace?: string;
  input?: unknown;
}

export type DispatchResult =
  | { mode: "off" }
  | { mode: "none" }
  | { refused: true; reason: "no-sandbox"; wanted: "exact" | "shadow" }
  | {
      mode: "exact";
      name: string;
      version: number;
      costUsd: 0;
      agent: string;
      evidence: {
        mode: "exact";
        name: string;
        version: number;
        inputs: unknown;
        exitCode: number;
        patchSha256?: string;
        toolSha256: string;
        durationMs: number;
      };
      dryRun: { patch?: string; effectPlan?: unknown };
    }
  | {
      mode: "partial";
      name: string;
      version: number;
      injection: string;
      fallback?: string;
    }
  | {
      mode: "shadow";
      name: string;
      version: number;
      agree?: "agree" | "disagree" | "disagree-scope";
    };

export function isCodifiable(run: { stage: string; kind?: string; mode?: string; class?: string }): boolean {
  for (const row of CODIFIABLE) {
    if ("class" in row) {
      if (run.class === row.class) return true;
      continue;
    }
    if ("mode" in row) {
      if (run.stage === row.stage && run.mode === row.mode) return true;
      continue;
    }
    if (run.stage === row.stage && run.kind === row.kind) return true;
  }
  return false;
}

const RANK: Record<Exclude<DispatchCeiling, "off">, number> = { partial: 1, shadow: 2, exact: 3 };

function capMode(wanted: "exact" | "shadow" | "partial", ceiling: DispatchCeiling): "exact" | "shadow" | "partial" | "off" {
  if (ceiling === "off") return "off";
  if (RANK[wanted] <= RANK[ceiling]) return wanted;
  return ceiling;
}

function asMatchable(entry: RegistryEntry) {
  return {
    name: entry.name,
    version: entry.version,
    state: entry.state,
    matcher: entry.matcher,
  };
}

function injectionFor(entry: RegistryEntry): string {
  return formatCodifiedPartial(entry.skillMarkdown ?? "");
}

export function shadowOutcome(opts: {
  hostChangedFiles: string[];
  writeGlobs: string[];
  hostTree: Record<string, string>;
  toolTree: Record<string, string>;
}): "agree" | "disagree" | "disagree-scope" {
  if (opts.hostChangedFiles.some((f) => !matchesAny(f, opts.writeGlobs))) return "disagree-scope";
  const keys = new Set([
    ...Object.keys(opts.hostTree).filter((k) => matchesAny(k, opts.writeGlobs)),
    ...Object.keys(opts.toolTree).filter((k) => matchesAny(k, opts.writeGlobs)),
  ]);
  for (const key of keys) {
    if ((opts.hostTree[key] ?? "") !== (opts.toolTree[key] ?? "")) return "disagree";
  }
  return "agree";
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  if (input.cfg.dispatch === "off") return { mode: "off" };
  if (!isCodifiable(input.run)) return { mode: "none" };

  const found = matchTools(Object.values(input.registry.entries).map(asMatchable), {
    title: input.run.title,
    planSteps: input.run.planSteps,
    likelyPaths: input.run.likelyPaths,
  });
  if (found.timedOut || found.matches.length === 0) return { mode: "none" };

  const primary = found.matches[0];
  if (primary === undefined) return { mode: "none" };
  const entry = input.registry.entries[primary.name];
  if (entry === undefined) return { mode: "none" };

  let wanted: "exact" | "shadow" | "partial";
  if (found.forcedPartial) {
    wanted = "partial";
  } else if (
    entry.state === "active" &&
    primary.pathsFit &&
    input.bindingsValid !== false &&
    !input.pathChurn
  ) {
    wanted = "exact";
  } else if (
    entry.state === "probationary" ||
    (entry.state === "active" && (!primary.pathsFit || input.pathChurn === true))
  ) {
    wanted = "shadow";
  } else {
    wanted = "partial";
  }

  const mode = capMode(wanted, input.cfg.dispatch);
  if (mode === "off") return { mode: "off" };

  if ((mode === "exact" || mode === "shadow") && !input.sandbox.available) {
    return { refused: true, reason: "no-sandbox", wanted: mode };
  }

  if (mode === "exact") {
    const dry = await input.runner?.run({
      dryRun: true,
      input: input.input ?? {},
      workspace: input.workspace ?? "",
      name: entry.name,
      version: entry.version,
    });
    if (dry && (dry.exitCode === 0 || dry.exitCode === 4)) {
      return {
        mode: "exact",
        name: entry.name,
        version: entry.version,
        costUsd: 0,
        agent: `codified:${entry.name}@${entry.version}`,
        evidence: {
          mode: "exact",
          name: entry.name,
          version: entry.version,
          inputs: input.input ?? {},
          exitCode: dry.exitCode,
          patchSha256: dry.json?.patchSha256,
          toolSha256: entry.toolSha256,
          durationMs: dry.durationMs,
        },
        dryRun: { patch: dry.patch, effectPlan: dry.json?.effectPlan },
      };
    }
    return {
      mode: "partial",
      name: entry.name,
      version: entry.version,
      injection: injectionFor(entry),
      fallback: entry.name,
    };
  }

  if (mode === "shadow") {
    return { mode: "shadow", name: entry.name, version: entry.version };
  }

  return {
    mode: "partial",
    name: found.forcedPartial ? found.matches.map((m) => m.name).join(",") : entry.name,
    version: entry.version,
    injection: found.forcedPartial
      ? found.matches
          .map((m) => input.registry.entries[m.name])
          .filter((e): e is RegistryEntry => e !== undefined)
          .map(injectionFor)
          .join("\n")
      : injectionFor(entry),
    fallback: entry.name,
  };
}

export type { ToolClass };
