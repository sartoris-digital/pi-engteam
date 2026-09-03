import { resolve } from "node:path";
import {
  isWriteRedirect,
  nestedShellCommands,
  outputFlagTargets,
  splitSegments,
  stripAssignments,
  tokenize,
  unquote,
  unsupportedShellConstruct,
} from "./shell.js";

export interface Classification {
  class: "safe" | "destructive";
  reason: string;
}

export const MAX_COMMAND_BYTES = 16 * 1024;
export const HARMLESS_REDIRECT_TARGETS: ReadonlySet<string> = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

export const SAFE_VERBS: ReadonlySet<string> = new Set([
  "cat", "bat", "less", "more", "head", "tail", "wc", "file", "stat", "xxd", "od",
  "grep", "rg", "ag", "fd", "ls", "la", "ll", "tree", "dir",
  "sort", "uniq", "cut", "tr", "jq", "yq", "diff", "comm",
  "pwd", "whoami", "hostname", "uname", "date", "which", "type",
  "ps", "df", "du", "top", "echo", "true", "false",
  "vitest", "jest", "mocha", "tap", "ava", "pytest", "tsc", "eslint",
]);

export const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "blame", "shortlog", "rev-parse", "ls-files",
  "describe", "cat-file", "check-ignore", "grep", "version",
]);

const SAFE_PNPM = new Set(["test", "list", "view", "why", "audit"]);
const GIT_BRANCH_WRITE = new Set(["-d", "-D", "-f", "-m", "-M", "--set-upstream", "-u"]);
const GIT_REMOTE_WRITE = new Set(["add", "remove", "set-url", "rename", "rm"]);
const GIT_STASH_WRITE = new Set(["push", "pop", "apply", "drop", "clear", "create", "store"]);
const MAX_NEST = 4;

function destructive(reason: string): Classification {
  return { class: "destructive", reason };
}
const SAFE: Classification = { class: "safe", reason: "read-only" };

function outsideCwd(target: string, cwd: string | undefined): boolean {
  if (!cwd) return target.startsWith("/") || target.split("/").includes("..");
  const abs = resolve(cwd, target);
  return abs !== cwd && !abs.startsWith(`${cwd}/`);
}

function classifyGit(cmd: string[], cwd: string | undefined): Classification {
  if (cmd.includes("-c") || cmd.some((w) => unquote(w).startsWith("--git-dir") || unquote(w).startsWith("--work-tree"))) {
    return destructive("git -c / --git-dir / --work-tree is always destructive inside a run");
  }
  for (let i = 1; i < cmd.length; i++) {
    if (unquote(cmd[i] as string) === "-C") {
      const t = cmd[i + 1];
      if (typeof t === "string" && outsideCwd(unquote(t), cwd)) return destructive(`git -C ${t} points outside cwd`);
    }
  }
  const writes = outputFlagTargets(cmd, "git");
  if (writes.length > 0) return destructive(`git output flag writes to ${writes.join(", ")}`);
  const sub = cmd.find((w, i) => i > 0 && !unquote(w).startsWith("-") && unquote(cmd[i - 1] as string) !== "-C") ?? "";
  const subName = unquote(sub);
  if (!subName) return SAFE;
  if (subName === "remote") return cmd.some((w) => GIT_REMOTE_WRITE.has(unquote(w))) ? destructive("git remote mutation") : SAFE;
  if (subName === "branch") return cmd.some((w) => GIT_BRANCH_WRITE.has(unquote(w)) || unquote(w).startsWith("--set-upstream")) ? destructive("git branch mutation") : SAFE;
  if (subName === "stash") {
    const action = unquote(cmd[cmd.indexOf("stash") + 1] ?? "");
    if (action === "" || GIT_STASH_WRITE.has(action) || action.startsWith("-")) return destructive("git stash mutation");
    return action === "list" || action === "show" ? SAFE : destructive("git stash mutation");
  }
  if (subName === "worktree") return unquote(cmd[cmd.indexOf("worktree") + 1] ?? "") === "list" ? SAFE : destructive("git worktree mutation");
  if (subName === "config") return cmd.some((w) => ["--get", "--list", "-l"].includes(unquote(w))) ? SAFE : destructive("git config write");
  if (subName === "submodule") return unquote(cmd[cmd.indexOf("submodule") + 1] ?? "") === "status" ? SAFE : destructive("git submodule mutation");
  if (subName === "update-ref" || subName === "symbolic-ref") return destructive(`git ${subName}`);
  if (subName === "reflog") return cmd.some((w) => unquote(w) === "expire" || unquote(w) === "delete") ? destructive("git reflog expire|delete") : SAFE;
  if (SAFE_GIT_SUBCOMMANDS.has(subName)) return SAFE;
  return destructive(`git ${subName} is not a safe subcommand`);
}

function classifySegment(segment: string, cwd: string | undefined, depth: number): Classification {
  const issue = unsupportedShellConstruct(segment);
  if (issue !== null) return destructive(`unsupported shell construct: ${issue}`);
  const { words, redirects } = tokenize(segment);
  for (const r of redirects) {
    if (isWriteRedirect(r.op) && !HARMLESS_REDIRECT_TARGETS.has(r.target)) return destructive(`redirect to file ${r.target}`);
  }
  const cmd = stripAssignments(words);
  const verb = unquote(cmd[0] ?? "").toLowerCase();
  if (!verb) return SAFE;
  const nested = nestedShellCommands(cmd);
  if (nested.length > 0) {
    if (depth >= MAX_NEST) return destructive("nested shell wrapper exceeded depth");
    let worst: Classification = SAFE;
    for (const inner of nested) {
      const next = classifyBash(inner, { cwd, depth: depth + 1 });
      if (next.class === "destructive") worst = next;
    }
    return worst;
  }
  if (["printenv", "set"].includes(verb)) return destructive("environment dump");
  if (verb === "env" && cmd.length === 1) return destructive("environment dump");
  if (verb === "export" && cmd.some((w) => unquote(w) === "-p")) return destructive("environment dump");
  if (verb === "declare" && cmd.some((w) => unquote(w) === "-p")) return destructive("environment dump");
  if (cmd.some((w) => /^\.e\*|~\/\.\*/.test(unquote(w)))) return destructive("glob token can expand to a dotfile");
  if (verb === "tee") {
    const files = cmd.slice(1).filter((a) => !unquote(a).startsWith("-") && !HARMLESS_REDIRECT_TARGETS.has(unquote(a)));
    if (files.length > 0) return destructive("tee to file");
  }
  if (verb === "git") return classifyGit(cmd, cwd);
  if (verb === "pnpm") {
    const sub = unquote(cmd[1] ?? "").toLowerCase();
    if (sub === "run") return destructive("pnpm run has unconfined script effects");
    return SAFE_PNPM.has(sub) ? SAFE : destructive("pnpm write");
  }
  if (verb === "npm" || verb === "yarn") {
    const sub = unquote(cmd[1] ?? "").toLowerCase();
    if (sub === "run") return destructive(`${verb} run has unconfined script effects`);
    return sub === "test" || sub === "ls" || sub === "list" || sub === "audit" ? SAFE : destructive(`${verb} ${sub}`);
  }
  if (verb === "gh") {
    const obj = unquote(cmd[1] ?? "").toLowerCase();
    const action = unquote(cmd[2] ?? "").toLowerCase();
    return (obj === "pr" || obj === "issue" || obj === "repo") && (action === "view" || action === "list" || action === "show")
      ? SAFE
      : destructive(`gh ${obj} ${action}`);
  }
  if (verb === "python" || verb === "python3" || verb === "node") return destructive("script execution");
  const writes = outputFlagTargets(cmd, verb);
  if (writes.length > 0) return destructive(`${verb} writes to ${writes.join(", ")}`);
  if (SAFE_VERBS.has(verb)) return SAFE;
  return destructive(`unknown verb '${verb}', defaulting to destructive`);
}

export function classifyBash(command: string, opts: { cwd?: string; depth?: number } = {}): Classification {
  if (typeof command !== "string") return destructive("missing command");
  if (command.length > MAX_COMMAND_BYTES) return destructive(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
  const issue = unsupportedShellConstruct(command);
  if (issue !== null) return destructive(`unsupported shell construct: ${issue}`);
  let worst: Classification = SAFE;
  for (const segment of splitSegments(command)) {
    const next = classifySegment(segment, opts.cwd, opts.depth ?? 0);
    if (next.class === "destructive") worst = next;
  }
  return worst;
}

export function fsEffectsKnown(verb: string, cmd: string[]): boolean {
  const v = unquote(verb).toLowerCase();
  if (SAFE_VERBS.has(v)) return true;
  if (v === "git" || v === "rm" || v === "tee" || v === "gh") return true;
  if (v === "pnpm" || v === "npm" || v === "yarn") return unquote(cmd[1] ?? "").toLowerCase() !== "run";
  if (["printenv", "set", "env", "export", "declare"].includes(v)) return true;
  if (nestedShellCommands(cmd).length > 0) return true;
  return false;
}
