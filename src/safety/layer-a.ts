import { resolve } from "node:path";
import type { Block, RunContext } from "./context.js";
import { defaultPathEnv, expandHome, isProtectedPath, isUnder, realish, type PathEnv } from "./paths.js";
import {
  assignmentName,
  isWriteRedirect,
  nestedShellCommands,
  splitSegments,
  stripAssignments,
  tokenize,
  unquote,
} from "./shell.js";

export const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "grep", "glob", "find", "ls"]);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

const HOME_VAR = /\$\{HOME\}|\$HOME/g;
const GIT_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]);
const MAX_NEST = 4;

const A = (reason: string): Block => ({ block: true, layer: "A", reason: `[Layer A] ${reason}`, terminate: true });

function isDangerousRm(command: string): boolean {
  return /rm\s+(-\w+\s+)*-[rf]{1,2}\s+(\/|~|~\/|\*|\$HOME|\.\.)(\s|$)/.test(command);
}

function dequote(command: string): string {
  return command.replace(/['"`]/g, "");
}

function isForcePushText(command: string): boolean {
  const s = dequote(command);
  if (/\bgit\b[\s\S]*?\bpush\b[\s\S]*?(?:--force(?:-with-lease)?(?:=[^\s]*)?|(?:^|[\s])-f(?:\s|$))/.test(s)) return true;
  if (/\bgit\b[\s\S]*?\bpush\b[\s\S]*?\+[A-Za-z0-9_/~.^${}-]*:/.test(s)) return true;
  return false;
}

function isAlternateGitDirText(command: string): boolean {
  const s = dequote(command);
  if (/\bGIT_DIR=/.test(s) || /\bGIT_WORK_TREE=/.test(s) || /\bGIT_COMMON_DIR=/.test(s) || /\bGIT_OBJECT_DIRECTORY=/.test(s)) {
    return true;
  }
  return /(?:^|\s)--git-dir(?:\s|=|$)/.test(s) || /(?:^|\s)--work-tree(?:\s|=|$)/.test(s);
}

function gitSubcommand(cmd: string[]): string | undefined {
  const words = cmd.map(unquote);
  let i = 1;
  while (i < words.length) {
    const w = words[i] as string;
    if (w === "-C" || w === "-c") { i += 2; continue; }
    if (w.startsWith("--git-dir") || w.startsWith("--work-tree") || w.startsWith("--namespace")) {
      i += w.includes("=") ? 1 : 2;
      continue;
    }
    if (w.startsWith("-")) { i++; continue; }
    break;
  }
  return words[i];
}

function gitPushFromArgv(cmd: string[]): boolean {
  return gitSubcommand(cmd) === "push";
}

function gitForceFromArgv(cmd: string[]): boolean {
  if (!gitPushFromArgv(cmd)) return false;
  const words = cmd.map(unquote);
  const sub = gitSubcommand(cmd);
  const start = sub === undefined ? words.length : words.indexOf(sub);
  for (const w of words.slice(start + 1)) {
    if (w === "--force" || w === "-f" || w === "--force-with-lease" || w.startsWith("--force-with-lease=") || w.startsWith("--force=")) {
      return true;
    }
    if (w.startsWith("+") && w.includes(":")) return true;
  }
  return false;
}

function isGitPushText(command: string): boolean {
  const s = dequote(command);
  return /(?:^|[\s;|&])git\s+push(?:\s|$)/.test(s);
}

function pathWord(word: string, env: PathEnv): string | null {
  if (word === "$(…)" || word === "(…)") return null;
  if (word.startsWith("-")) return null;
  if (!word.includes("/") && !word.startsWith("~") && !word.startsWith("$") && !word.startsWith(".")) return null;
  return word.replace(HOME_VAR, env.home);
}

function protectedWord(word: string, ctx: RunContext, env: PathEnv): string | null {
  const candidate = pathWord(word, env);
  if (candidate === null) return null;
  const check = isProtectedPath(candidate, ctx, env);
  return check.blocked ? (check.reason ?? candidate) : null;
}

function segmentBlock(segment: string, ctx: RunContext, env: PathEnv, depth: number): Block | null {
  const { words, redirects } = tokenize(segment);
  for (const word of words) {
    const name = assignmentName(word);
    if (name !== null && GIT_ENV.has(name)) return A("GIT_DIR / GIT_WORK_TREE is never allowed");
    const flag = unquote(word);
    if (flag === "--git-dir" || flag.startsWith("--git-dir=") || flag === "--work-tree" || flag.startsWith("--work-tree=")) {
      return A("git --git-dir / --work-tree is never allowed");
    }
  }
  const cmd = stripAssignments(words);
  if (gitPushFromArgv(cmd) || gitForceFromArgv(cmd)) return A("git push is never allowed");
  if (depth < MAX_NEST) {
    for (const nested of nestedShellCommands(cmd)) {
      const hit = commandBlock(nested, ctx, env, depth + 1);
      if (hit !== null) return hit;
    }
  }
  const verb = unquote(cmd[0] ?? "");
  if (verb === "launchctl" && ["load", "unload", "enable", "start", "submit", "kickstart", "bootout"].includes(unquote(cmd[1] ?? ""))) {
    return A("launchd modification is never allowed");
  }
  if (verb === "systemctl" && ["enable", "disable", "start", "stop", "restart", "daemon-reload", "mask", "unmask", "edit", "link"].includes(unquote(cmd[1] ?? ""))) {
    return A("systemd modification is never allowed");
  }
  if (verb === "crontab" && !cmd.some((w) => unquote(w) === "-l")) return A("crontab modification is never allowed");
  if (verb === "dd" && cmd.some((w) => /^of=\/dev\//.test(unquote(w)))) return A("writing to a device is never allowed");
  if (
    /^mkfs(\.|$)/.test(verb) || verb === "fdisk" || verb === "parted" || verb === "shred" || verb === "wipefs" ||
    (verb === "diskutil" && cmd.some((w) => /^(erase|partition|reformat|secureErase|zeroDisk|randomDisk)/i.test(unquote(w))))
  ) {
    return A("disk formatting is never allowed");
  }
  for (const word of cmd.slice(1)) {
    const hit = protectedWord(unquote(word), ctx, env);
    if (hit !== null) return A(`protected path in command: ${hit}`);
  }
  for (const r of redirects) {
    if (!isWriteRedirect(r.op)) continue;
    const hit = protectedWord(r.target, ctx, env);
    if (hit !== null) return A(`write redirect to protected path: ${hit}`);
  }
  return null;
}

export function commandBlock(command: string, ctx: RunContext, env: PathEnv = defaultPathEnv(), depth = 0): Block | null {
  const dequoted = dequote(command);
  if (/(^|[\/\s])_controller([\/\s]|$)/.test(command) || /(^|[\/\s])_controller([\/\s]|$)/.test(dequoted)) {
    return A("the _controller approval context is never allowed");
  }
  if (/tasks\.json/i.test(command) || /tasks\.json/i.test(dequoted)) return A("tasks.json is host-owned");
  if (/\.pi\/(?:sdlc-factory|engineering-team)\/expertise/i.test(command)) return A("expertise files are host-owned");
  if (isDangerousRm(command) || isDangerousRm(dequoted)) return A("destructive rm of a root or home path is never allowed");
  if (isForcePushText(command) || isGitPushText(command)) return A("git push is never allowed");
  if (isAlternateGitDirText(command)) return A("git --git-dir / GIT_DIR is never allowed");
  if (/(?:^|[;&|\n]\s*)sudo\s/.test(command) || /(?:^|[;&|\n]\s*)sudo\s/.test(dequoted)) return A("sudo is never allowed");
  if (/(?:npm|pnpm|yarn)\s+publish(?:\s|$)/.test(command) || /(?:npm|pnpm|yarn)\s+publish(?:\s|$)/.test(dequoted)) {
    return A("publish is never allowed");
  }

  for (const segment of splitSegments(command)) {
    const hit = segmentBlock(segment, ctx, env, depth);
    if (hit !== null) return hit;
  }
  return null;
}

export function hardBlock(tool: string, input: Record<string, unknown>, ctx: RunContext, env: PathEnv = defaultPathEnv()): Block | null {
  if (PATH_TOOLS.has(tool)) {
    const p = input.path;
    if (typeof p !== "string" || p.length === 0) return null;
    const check = isProtectedPath(p, ctx, env);
    return check.blocked ? A(`protected path ${p}: ${check.reason}`) : null;
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = input.command;
    if (typeof command !== "string") return null;
    return commandBlock(command, ctx, env);
  }
  return null;
}

function controllerProtected(p: string, env: PathEnv): string | null {
  const abs = realish(resolve(expandHome(p.replace(HOME_VAR, env.home), env.home)));
  const factory = realish(resolve(env.factoryHome));
  const home = realish(resolve(env.home));
  if (isUnder(abs, factory)) return `the factory state dir ${env.factoryHome} is host-only`;
  for (const keyring of ["Library/Keychains", ".local/share/keyrings"]) {
    if (isUnder(abs, `${home}/${keyring}`)) return "the OS keyring store is off-limits";
  }
  if (isUnder(abs, "/Library/Keychains")) return "the OS keyring store is off-limits";
  return null;
}

export function controllerHardBlock(tool: string, input: Record<string, unknown>, env: PathEnv = defaultPathEnv()): Block | null {
  const soft = (reason: string): Block => ({ block: true, layer: "A", reason: `[Layer A] ${reason}` });
  if (PATH_TOOLS.has(tool)) {
    const p = input.path;
    if (typeof p !== "string" || p.length === 0) return null;
    const hit = controllerProtected(p, env);
    return hit === null ? null : soft(`protected path ${p}: ${hit}`);
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = input.command;
    if (typeof command !== "string") return null;
    if (/vault\.sqlite|Keychains|\.local\/share\/keyrings/.test(command)) return soft("command mentions the vault or the OS keyring");
    for (const segment of splitSegments(command)) {
      const { words, redirects } = tokenize(segment);
      for (const w of [...words, ...redirects.map((r) => r.target)]) {
        const candidate = pathWord(w, env);
        if (candidate === null) continue;
        const hit = controllerProtected(candidate, env);
        if (hit !== null) return soft(`protected path in command ${w}: ${hit}`);
      }
    }
    if (command.includes(env.factoryHome) || /~\/\.pi\/sdlc-factory/.test(command)) {
      return soft("command mentions the factory state dir");
    }
  }
  return null;
}
