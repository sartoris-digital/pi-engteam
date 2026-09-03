import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { HARMLESS_REDIRECT_TARGETS, classifyBash } from "./classifier.js";
import type { Block, RunContext } from "./context.js";
import { defaultPathEnv, expandHome, isUnder, realish, type PathEnv } from "./paths.js";
import { GROUP_PLACEHOLDER, SUBST_PLACEHOLDER, isWriteRedirect, splitSegments, stripAssignments, tokenize } from "./shell.js";

export type BashPolicy = "none" | "read-only" | "full";

export interface DomainPolicy {
  readRoots: string[];
  upsertRoots: string[];
  deleteRoots: string[];
  denyUpsert: string[];
  bashPolicy: BashPolicy;
}

export const EMPTY_POLICY: DomainPolicy = { readRoots: [], upsertRoots: [], deleteRoots: [], denyUpsert: [], bashPolicy: "none" };

export interface PolicyAgentEntry {
  read?: string[];
  upsert?: string[];
  delete?: string[];
  deny?: string[];
  bash?: BashPolicy;
}

export interface PolicyFile {
  schemaVersion: 1;
  agents: Record<string, PolicyAgentEntry>;
}

const BASH_POLICIES: readonly BashPolicy[] = ["none", "read-only", "full"];
const HOME_VAR = /\$\{HOME\}|\$HOME/g;

export function parsePolicyFile(text: string): PolicyFile {
  const body = text.startsWith("<!--") ? text.slice(text.indexOf("\n") + 1) : text;
  const raw: unknown = parseYaml(body);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("policy file must be a YAML mapping");
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== 1) throw new Error("policy file schemaVersion must be 1");
  if (typeof doc.agents !== "object" || doc.agents === null || Array.isArray(doc.agents)) throw new Error("policy file needs an agents mapping");
  const agents: Record<string, PolicyAgentEntry> = {};
  for (const [name, entry] of Object.entries(doc.agents as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`policy agent ${name} must be a mapping`);
    const e = entry as Record<string, unknown>;
    const list = (key: string): string[] | undefined => {
      const value = e[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || !value.every((s) => typeof s === "string" && s.length > 0)) {
        throw new Error(`policy agent ${name}.${key} must be a list of non-empty strings`);
      }
      return value as string[];
    };
    const bash = e.bash;
    if (bash !== undefined && !BASH_POLICIES.includes(bash as BashPolicy)) {
      throw new Error(`policy agent ${name}.bash must be one of none, read-only, full`);
    }
    agents[name] = { read: list("read"), upsert: list("upsert"), delete: list("delete"), deny: list("deny"), bash: bash as BashPolicy | undefined };
  }
  return { schemaVersion: 1, agents };
}

export function policyForAgent(file: PolicyFile, agent: string): DomainPolicy {
  const entry = file.agents[agent];
  if (entry === undefined) return EMPTY_POLICY;
  return {
    readRoots: entry.read ?? [],
    upsertRoots: entry.upsert ?? [],
    deleteRoots: entry.delete ?? [],
    denyUpsert: entry.deny ?? [],
    bashPolicy: entry.bash ?? "none",
  };
}

export function loadDomainPolicy(policyFile: string, policySha: string, agent: string): DomainPolicy {
  const text = readFileSync(policyFile, "utf8");
  const sha = createHash("sha256").update(text).digest("hex");
  if (sha !== policySha) throw new Error(`policy file ${policyFile} sha256 ${sha} does not match PI_SDLC_POLICY_SHA ${policySha}`);
  return policyForAgent(parsePolicyFile(text), agent);
}

export function resolveRoot(root: string, ctx: RunContext): string {
  const substituted = root.replace(/\$\{([A-Z_]+)\}/g, (_match, name: string) => {
    if (name === "RUN_DIR") return ctx.runDir;
    if (name === "RUN_ID") return ctx.runId;
    throw new Error(`policy root "${root}" uses unsupported placeholder \${${name}}`);
  });
  if (substituted.startsWith("~")) throw new Error(`policy root "${root}" may not use ~`);
  return isAbsolute(substituted) ? resolve(substituted) : resolve(ctx.workspaceDir, substituted);
}

function normalizeRoot(absRoot: string): string {
  const parts = absRoot.split("/");
  const globIndex = parts.findIndex((segment) => /[*?]/.test(segment));
  if (globIndex === -1) return realish(absRoot);
  const prefix = parts.slice(0, globIndex).join("/") || "/";
  return [realish(prefix).replace(/\/$/, ""), ...parts.slice(globIndex)].join("/");
}

export function resolvePolicy(policy: DomainPolicy, ctx: RunContext): DomainPolicy {
  const resolveAll = (roots: readonly string[]): string[] => roots.map((root) => normalizeRoot(resolveRoot(root, ctx)));
  return {
    readRoots: resolveAll(policy.readRoots),
    upsertRoots: resolveAll([...policy.upsertRoots, ...ctx.extraUpsert]),
    deleteRoots: resolveAll(policy.deleteRoots),
    denyUpsert: resolveAll([...policy.denyUpsert, ...ctx.denyUpsert]),
    bashPolicy: policy.bashPolicy,
  };
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesRoot(absPath: string, absRoot: string): boolean {
  if (!/[*?]/.test(absRoot)) return isUnder(absPath, absRoot);
  const re = globToRegExp(absRoot);
  let cursor = absPath;
  for (;;) {
    if (re.test(cursor)) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

type Target = { ok: true; abs: string } | { ok: false; why: string };

function targetPath(p: string, ctx: RunContext, env: PathEnv): Target {
  if (p === SUBST_PLACEHOLDER || p === GROUP_PLACEHOLDER) return { ok: false, why: `${p === SUBST_PLACEHOLDER ? "command substitution" : "subshell"} used as a path` };
  const withHome = p.replace(HOME_VAR, env.home);
  if (withHome.includes("$")) return { ok: false, why: `"${p}" contains an unresolved variable` };
  const expanded = expandHome(withHome, env.home);
  if (expanded.split("/").includes("..")) return { ok: false, why: `"${p}" contains ".." segments; use a canonical path` };
  return { ok: true, abs: realish(resolve(ctx.workspaceDir, expanded)) };
}

export function domainBlock(
  tool: string,
  input: Record<string, unknown>,
  ctx: RunContext,
  policy: DomainPolicy,
  env: PathEnv = defaultPathEnv(),
): Block | null {
  const D = (detail: string): Block => ({ block: true, layer: "D", reason: `[Layer D] ${detail}` });
  let resolved: DomainPolicy;
  try {
    resolved = resolvePolicy(policy, ctx);
  } catch (error) {
    return D(`policy for "${ctx.agent}" refused to apply: ${(error as Error).message}`);
  }
  const checkWrite = (p: string): Block | null => {
    const target = targetPath(p, ctx, env);
    if (!target.ok) return D(`write target ${target.why}`);
    const denied = resolved.denyUpsert.find((root) => matchesRoot(target.abs, root));
    if (denied !== undefined) return D(`${target.abs} is denied for ${ctx.agent} (denyUpsert root ${denied})`);
    if (resolved.upsertRoots.some((root) => matchesRoot(target.abs, root))) return null;
    return D(`${target.abs} is outside ${ctx.agent}'s upsert roots [${resolved.upsertRoots.join(", ")}]`);
  };
  const checkDelete = (p: string): Block | null => {
    const target = targetPath(p, ctx, env);
    if (!target.ok) return D(`delete target ${target.why}`);
    if (resolved.deleteRoots.some((root) => matchesRoot(target.abs, root))) return null;
    return D(`${target.abs} is outside ${ctx.agent}'s delete roots [${resolved.deleteRoots.join(", ")}]`);
  };
  if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls" || tool === "glob") {
    if (resolved.readRoots.length === 0) return null;
    const p = input.path;
    if (typeof p !== "string" || p.length === 0) return null;
    const target = targetPath(p, ctx, env);
    if (!target.ok) return D(`read target ${target.why}`);
    return resolved.readRoots.some((root) => matchesRoot(target.abs, root)) ? null : D(`${ctx.agent} may not read ${target.abs}`);
  }
  if (tool === "write" || tool === "edit") {
    const p = input.path;
    if (typeof p !== "string" || p.length === 0) return D(`${tool} without a path`);
    return checkWrite(p);
  }
  if (tool === "bash") {
    if (resolved.bashPolicy === "none") return D(`${ctx.agent} has no bash in this stage`);
    const command = input.command;
    if (typeof command !== "string") return D("bash without a command");
    if (resolved.bashPolicy === "read-only") {
      const c = classifyBash(command, { cwd: ctx.workspaceDir });
      return c.class === "safe" ? null : D(`${ctx.agent} bash is read-only: ${c.reason}`);
    }
    for (const segment of splitSegments(command)) {
      const { words, redirects } = tokenize(segment);
      for (const r of redirects) {
        if (!isWriteRedirect(r.op) || HARMLESS_REDIRECT_TARGETS.has(r.target)) continue;
        const block = checkWrite(r.target);
        if (block !== null) return block;
      }
      const cmd = stripAssignments(words);
      const verb = cmd[0];
      if (verb === "tee") {
        for (const t of cmd.slice(1).filter((a) => !a.startsWith("-") && !HARMLESS_REDIRECT_TARGETS.has(a))) {
          const block = checkWrite(t);
          if (block !== null) return block;
        }
      }
      if (verb === "rm") {
        for (const t of cmd.slice(1).filter((a) => !a.startsWith("-"))) {
          const block = checkDelete(t);
          if (block !== null) return block;
        }
      }
    }
    return null;
  }
  return null;
}
