import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { factoryHome } from "../home.js";
import type { RunContext } from "./context.js";

export interface PathEnv {
  home: string;
  factoryHome: string;
  verdictFile?: string;
}

export interface PathCheck {
  blocked: boolean;
  reason?: string;
}

export const PROTECTED_SYSTEM_PREFIXES: readonly string[] = [
  "/etc", "/usr", "/bin", "/sbin", "/boot", "/System", "/Library/System",
  "/private/etc", "/private/var/db", "/var/log", "/var/db", "/var/root",
];

export const PROTECTED_HOME_PATTERNS: readonly string[] = [
  ".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".netrc", ".pgpass",
  "Library/Keychains", ".config/gh", ".git-credentials", ".npmrc", ".azure",
  ".docker", ".config/herdr", ".config/jira",
];

export const PROTECTED_ABSOLUTE_PATHS: readonly string[] = ["/Library/Keychains"];

export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /\/id_rsa(?:$|\.)/, /\/id_ed25519(?:$|\.)/, /\/id_ecdsa(?:$|\.)/, /\.pem$/, /\.key$/, /\/credentials$/,
];

export const ORCH_OWNED: readonly string[] = [
  "state.json", "events.jsonl", "conversation.jsonl", "agent-activity.jsonl", "feature-decisions.json",
  "_verdicts", "_telemetry", "_activity", ".secret", "approvals/pending", "approvals/granted",
  "_children.json", "evidence", "_factory", "ticket.prior.json",
];

export const ALLOWED_DEVICES: ReadonlySet<string> = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
export const JUDGE_AGENT = "judge";

const ENV_FILE_RE = /\.env(?!\.(?:sample|example))(?:\.[a-zA-Z0-9._-]+)?$/;

export function defaultPathEnv(): PathEnv {
  return { home: homedir(), factoryHome: factoryHome() };
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

export function isUnder(abs: string, root: string): boolean {
  const a = abs.replace(/\/+$/, "") || "/";
  const r = root.replace(/\/+$/, "") || "/";
  return a === r || a.startsWith(`${r}/`);
}

export function realish(abs: string): string {
  const strip = (p: string): string => (p.startsWith("/System/Volumes/Data/") ? p.slice("/System/Volumes/Data".length) : p);
  try {
    return strip(realpathSync(abs));
  } catch {
    let cur = abs;
    let suffix = "";
    while (cur !== dirname(cur)) {
      const parent = dirname(cur);
      const tail = cur.slice(parent.length);
      try {
        return strip(realpathSync(parent) + tail + suffix);
      } catch {
        suffix = tail + suffix;
        cur = parent;
      }
    }
    return abs;
  }
}

export function resolveToolPath(p: string, ctx: RunContext, env: PathEnv = defaultPathEnv()): string {
  return realish(resolve(ctx.workspaceDir, expandHome(p, env.home)));
}

function hit(reason: string): PathCheck {
  return { blocked: true, reason };
}

function relUnder(abs: string, root: string): string | null {
  const a = abs.replace(/\/+$/, "") || "/";
  const r = root.replace(/\/+$/, "") || "/";
  if (a === r) return "";
  if (a.startsWith(`${r}/`)) return a.slice(r.length + 1);
  return null;
}

function judgeException(rel: string, agent: string): boolean {
  if (agent !== JUDGE_AGENT) return false;
  if (rel === "verdict.md" || rel === "dependency-approval.json") return true;
  if (rel.startsWith("approvals/") && !rel.startsWith("approvals/pending/") && !rel.startsWith("approvals/granted/") && rel !== "approvals/pending" && rel !== "approvals/granted") {
    return true;
  }
  return /^evidence\/judge-[^/]+\.json$/.test(rel);
}

export function isProtectedPath(p: string, ctx: RunContext, env: PathEnv = defaultPathEnv()): PathCheck {
  const expanded = expandHome(p.replace(/\$\{HOME\}|\$HOME/g, env.home), env.home);
  const abs = realish(resolve(expanded.startsWith("/") ? expanded : resolve(ctx.workspaceDir, expanded)));
  const runAbs = realish(resolve(ctx.runDir));
  const workspaceAbs = realish(resolve(ctx.workspaceDir));

  if (env.verdictFile !== undefined && abs === realish(resolve(env.verdictFile))) return { blocked: false };

  for (const prefix of PROTECTED_SYSTEM_PREFIXES) {
    if (isUnder(abs, prefix)) return hit(`protected system path ${prefix}`);
  }
  for (const absProt of PROTECTED_ABSOLUTE_PATHS) {
    if (isUnder(abs, absProt)) return hit(`protected path ${absProt}`);
  }
  for (const rel of PROTECTED_HOME_PATTERNS) {
    if (isUnder(abs, `${env.home}/${rel}`)) return hit(`protected credential path ~/${rel}`);
  }

  // Run-dir exceptions (judge roots, verdict slot already handled) must win over the
  // factoryHome block: ctx.runDir lives under factoryHome/runs/<id>.
  const rel = relUnder(abs, runAbs);
  if (rel !== null) {
    if (judgeException(rel, ctx.agent)) return { blocked: false };
    if (rel === ".secret" || rel.startsWith("approvals/pending") || rel.startsWith("approvals/granted")) {
      return hit(`orchestrator-owned path ${rel}`);
    }
    for (const owned of ORCH_OWNED) {
      if (rel === owned || rel.startsWith(`${owned}/`)) return hit(`orchestrator-owned path ${owned}`);
    }
    const first = rel.split("/")[0];
    if (first !== undefined && ["_verdicts", "_telemetry", "_activity", "evidence", "_factory", "approvals"].includes(first)) {
      return hit(`orchestrator-owned path ${first}`);
    }
  }

  if (isUnder(abs, env.factoryHome) && !isUnder(abs, runAbs) && !isUnder(abs, workspaceAbs)) {
    return hit(`the factory state dir ${env.factoryHome} is host-only`);
  }
  for (const pat of SECRET_FILE_PATTERNS) {
    if (pat.test(abs)) return hit(`secret file pattern ${pat}`);
  }
  if (ENV_FILE_RE.test(basename(abs))) return hit(".env file access is blocked");
  if (isUnder(abs, `${workspaceAbs}/.git`) || isUnder(abs, `${realish(resolve(ctx.projectRoot))}/.git`)) {
    return hit("shared .git is host-only");
  }
  if (isUnder(abs, realish(resolve(ctx.projectRoot))) && !isUnder(abs, workspaceAbs)) {
    return hit("the main checkout is outside the worktree");
  }
  const worktrees = `${env.factoryHome}/worktrees`;
  if (isUnder(abs, worktrees) && !isUnder(abs, workspaceAbs)) {
    return hit("sibling factory worktrees are off-limits");
  }
  return { blocked: false };
}
