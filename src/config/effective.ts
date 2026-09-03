import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { factoryHome } from "../home.js";
import { DEFAULTS } from "./defaults.js";
import { ConfigError } from "./errors.js";
import { canonicalJson, isPlainObject, type JsonObject } from "./json.js";
import {
  committedConfigPath,
  expandHome,
  findRepoEntry,
  globalConfigPath,
  localConfigPath,
  readCommitted,
  readGlobal,
  readLocal,
} from "./layers.js";
import { mergeLayers, type ConfigLayer } from "./merge.js";
import { assertNarrowing } from "./narrowing.js";
import type {
  Branching,
  CheckDef,
  EffectiveConfig,
  EffectiveRepoConfig,
  LayerName,
  OperatorConfig,
  RepoDefaults,
} from "./schema.js";

const execFileAsync = promisify(execFile);

export interface LoadOptions {
  /** Factory home; defaults to factoryHome() (honours PI_SDLC_HOME). */
  home?: string;
  /** Resolver for branching.base when no layer sets it; defaults to resolveDefaultBase (git). Tests inject a stub. */
  defaultBase?: (repoRoot: string) => Promise<string>;
}

/** Operator block after merging, before worktreeRoot is filled in. */
type MergedOperator = Omit<OperatorConfig, "worktreeRoot"> & { worktreeRoot?: string };

/** Repo block after merging, before the probed keys are filled in. */
type MergedRepo = Omit<EffectiveRepoConfig, "repoRoot" | "remote" | "branching" | "checks"> & {
  branching: Omit<Branching, "base" | "target"> & { base?: string; target?: string };
  checks: Array<Omit<CheckDef, "timeoutSeconds"> & { timeoutSeconds?: number }>;
};

/**
 * Spec §2.1: builtin → global → committed → repos[].overrides → local, with the narrowing
 * rule applied at every step. The result is pinned to a run by `configSha`, and its
 * `repo.generatedDocPatterns` is the authoritative pattern list for the gate and the
 * checkpoint excludes (never the built-in constant, which a layer may have extended).
 */
export async function loadEffectiveConfig(repoPath: string, opts: LoadOptions = {}): Promise<EffectiveConfig> {
  const home = opts.home ?? factoryHome();
  const repoRoot = path.resolve(repoPath);
  const global = await readGlobal(home);
  const entry = findRepoEntry(global, repoRoot);
  const globalPath = globalConfigPath(home);

  const operatorLayers: ConfigLayer[] = [
    { name: "builtin", path: null, value: asJson(DEFAULTS.operator) },
    { name: "global", path: globalPath, value: asJson(global.operator ?? {}) },
  ];
  const repoLayers: ConfigLayer[] = [
    { name: "builtin", path: null, value: asJson(DEFAULTS.repo) },
    { name: "global", path: globalPath, value: asJson(global.defaults ?? {}) },
    { name: "committed", path: committedConfigPath(repoRoot), value: asJson(await readCommitted(repoRoot)) },
    { name: "overrides", path: globalPath, value: asJson(entry?.overrides ?? {}) },
    { name: "local", path: localConfigPath(repoRoot), value: asJson(await readLocal(repoRoot)) },
  ];

  const op = mergeLayers(operatorLayers);
  const rp = mergeLayers(repoLayers, {
    beforeApply: (layer, current) =>
      assertNarrowing(layer.value as unknown as RepoDefaults, current as unknown as RepoDefaults, layer.name),
  });
  assertDefaultsPresent(op.config, asJson(DEFAULTS.operator), "operator");
  assertDefaultsPresent(rp.config, asJson(DEFAULTS.repo), "repo");

  const provenance: Record<string, LayerName> = {};
  for (const [key, layer] of Object.entries(op.provenance)) provenance[`operator.${key}`] = layer;
  for (const [key, layer] of Object.entries(rp.provenance)) provenance[`repo.${key}`] = layer;

  const mergedOperator = op.config as unknown as MergedOperator;
  let worktreeRoot: string;
  if (mergedOperator.worktreeRoot === undefined) {
    worktreeRoot = path.join(home, "worktrees");
    provenance["operator.worktreeRoot"] = "builtin";
  } else {
    worktreeRoot = expandHome(mergedOperator.worktreeRoot);
  }
  const operator: OperatorConfig = { ...mergedOperator, worktreeRoot };

  const merged = rp.config as unknown as MergedRepo;
  let base = merged.branching.base;
  if (base === undefined) {
    base = await (opts.defaultBase ?? resolveDefaultBase)(repoRoot);
    provenance["repo.branching.base"] = "builtin";
  }
  let target = merged.branching.target;
  if (target === undefined) {
    target = base;
    provenance["repo.branching.target"] = provenance["repo.branching.base"] ?? "builtin";
  }
  const remote = entry?.remote ?? "origin";
  provenance["repo.remote"] = entry?.remote === undefined ? "builtin" : "global";
  provenance["repo.repoRoot"] = "builtin";

  const repo: EffectiveRepoConfig = {
    ...merged,
    branching: { ...merged.branching, base, target },
    checks: merged.checks.map((check) => ({
      ...check,
      timeoutSeconds: check.timeoutSeconds ?? merged.checksTimeoutSeconds,
    })),
    repoRoot,
    remote,
  };

  const configSha = sha256Hex(canonicalJson({ operator, repo }));
  return { operator, repo, provenance, configSha };
}

/**
 * Default branch of the main checkout: `origin/HEAD` if the remote's HEAD is known locally,
 * else the checked-out branch (works on an unborn branch), else "main".
 */
export async function resolveDefaultBase(repoRoot: string): Promise<string> {
  const originHead = await gitOutput(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead !== null) return originHead.replace(/^origin\//, "");
  const head = await gitOutput(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (head !== null) return head;
  return "main";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const out = stdout.trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** `null` may only delete keys the built-in layer does not define; anything else would leave a hole. */
function assertDefaultsPresent(merged: JsonObject, defaults: JsonObject, prefix: string): void {
  for (const [key, value] of Object.entries(defaults)) {
    const dotted = `${prefix}.${key}`;
    const actual = merged[key];
    if (actual === undefined) {
      throw new ConfigError(
        "deleted-default",
        `config: "${dotted}" was deleted with null but has a built-in default; set a value instead`,
        { keyPath: dotted },
      );
    }
    if (isPlainObject(value) && isPlainObject(actual)) assertDefaultsPresent(actual, value, dotted);
  }
}

function asJson(value: unknown): JsonObject {
  return structuredClone(value) as JsonObject;
}
