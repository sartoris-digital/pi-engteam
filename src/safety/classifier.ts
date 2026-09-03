import { resolve } from "node:path";
import { isWriteRedirect, splitSegments, stripAssignments, tokenize } from "./shell.js";

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

const SAFE_PNPM = new Set(["test", "run", "list", "view", "why", "audit"]);
const GIT_BRANCH_WRITE = new Set(["-d", "-D", "-f", "-m", "-M", "--set-upstream", "-u"]);
const GIT_REMOTE_WRITE = new Set(["add", "remove", "set-url", "rename", "rm"]);
const GIT_STASH_WRITE = new Set(["push", "pop", "apply", "drop", "clear", "create", "store"]);

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
  if (cmd.includes("-c") || cmd.some((w) => w.startsWith("--git-dir") || w.startsWith("--work-tree"))) {
    return destructive("git -c / --git-dir / --work-tree is always destructive inside a run");
  }
  for (let i = 1; i < cmd.length; i++) {
    if (cmd[i] === "-C") {
      const t = cmd[i + 1];
      if (typeof t === "string" && outsideCwd(t, cwd)) return destructive(`git -C ${t} points outside cwd`);
    }
  }
  const sub = cmd.find((w, i) => i > 0 && !w.startsWith("-") && cmd[i - 1] !== "-C") ?? "";
  if (!sub) return SAFE;
  if (sub === "remote") return cmd.some((w) => GIT_REMOTE_WRITE.has(w)) ? destructive("git remote mutation") : SAFE;
  if (sub === "branch") return cmd.some((w) => GIT_BRANCH_WRITE.has(w) || w.startsWith("--set-upstream")) ? destructive("git branch mutation") : SAFE;
  if (sub === "stash") {
    const action = cmd[cmd.indexOf("stash") + 1];
    if (action === undefined || GIT_STASH_WRITE.has(action) || action.startsWith("-")) return destructive("git stash mutation");
    return action === "list" || action === "show" ? SAFE : destructive("git stash mutation");
  }
  if (sub === "worktree") return (cmd[cmd.indexOf("worktree") + 1] ?? "") === "list" ? SAFE : destructive("git worktree mutation");
  if (sub === "config") return cmd.includes("--get") || cmd.includes("--list") || cmd.includes("-l") ? SAFE : destructive("git config write");
  if (sub === "submodule") return (cmd[cmd.indexOf("submodule") + 1] ?? "") === "status" ? SAFE : destructive("git submodule mutation");
  if (sub === "update-ref" || sub === "symbolic-ref") return destructive(`git ${sub}`);
  if (sub === "reflog") return cmd.includes("expire") || cmd.includes("delete") ? destructive("git reflog expire|delete") : SAFE;
  if (SAFE_GIT_SUBCOMMANDS.has(sub)) return SAFE;
  return destructive(`git ${sub} is not a safe subcommand`);
}

function classifySegment(segment: string, cwd: string | undefined): Classification {
  const { words, redirects } = tokenize(segment);
  for (const r of redirects) {
    if (isWriteRedirect(r.op) && !HARMLESS_REDIRECT_TARGETS.has(r.target)) return destructive(`redirect to file ${r.target}`);
  }
  const cmd = stripAssignments(words);
  const verb = (cmd[0] ?? "").toLowerCase();
  if (!verb) return SAFE;
  if (["printenv", "set"].includes(verb)) return destructive("environment dump");
  if (verb === "env" && cmd.length === 1) return destructive("environment dump");
  if (verb === "export" && cmd.includes("-p")) return destructive("environment dump");
  if (verb === "declare" && cmd.includes("-p")) return destructive("environment dump");
  if (cmd.some((w) => /^\.e\*|~\/\.\*/.test(w))) return destructive("glob token can expand to a dotfile");
  if (verb === "tee") {
    const files = cmd.slice(1).filter((a) => !a.startsWith("-") && !HARMLESS_REDIRECT_TARGETS.has(a));
    if (files.length > 0) return destructive("tee to file");
  }
  if (verb === "git") return classifyGit(cmd, cwd);
  if (verb === "pnpm") return SAFE_PNPM.has((cmd[1] ?? "").toLowerCase()) ? SAFE : destructive("pnpm write");
  if (verb === "npm" || verb === "yarn") {
    const sub = (cmd[1] ?? "").toLowerCase();
    return sub === "test" || sub === "run" || sub === "ls" || sub === "list" || sub === "audit" ? SAFE : destructive(`${verb} ${sub}`);
  }
  if (verb === "gh") {
    const obj = (cmd[1] ?? "").toLowerCase();
    const action = (cmd[2] ?? "").toLowerCase();
    return (obj === "pr" || obj === "issue" || obj === "repo") && (action === "view" || action === "list" || action === "show")
      ? SAFE
      : destructive(`gh ${obj} ${action}`);
  }
  if (verb === "python" || verb === "python3" || verb === "node") return destructive("script execution");
  if (SAFE_VERBS.has(verb)) return SAFE;
  return destructive(`unknown verb '${verb}', defaulting to destructive`);
}

export function classifyBash(command: string, opts: { cwd?: string } = {}): Classification {
  if (typeof command !== "string") return destructive("missing command");
  if (command.length > MAX_COMMAND_BYTES) return destructive(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
  let worst: Classification = SAFE;
  for (const segment of splitSegments(command)) {
    const next = classifySegment(segment, opts.cwd);
    if (next.class === "destructive") worst = next;
  }
  return worst;
}
