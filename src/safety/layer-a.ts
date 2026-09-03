import { resolve } from "node:path";
import type { Block, RunContext } from "./context.js";
import { defaultPathEnv, expandHome, isProtectedPath, isUnder, realish, type PathEnv } from "./paths.js";
import { isWriteRedirect, splitSegments, stripAssignments, tokenize } from "./shell.js";

export const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "grep", "glob", "find", "ls"]);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

const HOME_VAR = /\$\{HOME\}|\$HOME/g;

const A = (reason: string): Block => ({ block: true, layer: "A", reason: `[Layer A] ${reason}`, terminate: true });

function isDangerousRm(command: string): boolean {
  return /rm\s+(-\w+\s+)*-[rf]{1,2}\s+(\/|~|~\/|\*|\$HOME|\.\.)(\s|$)/.test(command);
}
function isForcePush(command: string): boolean {
  return /git\s+push\s+.*(?:--force(?:-with-lease)?|-f)(?:\s|$)/.test(command);
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

export function commandBlock(command: string, ctx: RunContext, env: PathEnv = defaultPathEnv()): Block | null {
  const dequoted = command.replace(/['"`]/g, "");
  if (/(^|[\/\s])_controller([\/\s]|$)/.test(command) || /(^|[\/\s])_controller([\/\s]|$)/.test(dequoted)) {
    return A("the _controller approval context is never allowed");
  }
  if (/tasks\.json/i.test(command) || /tasks\.json/i.test(dequoted)) return A("tasks.json is host-owned");
  if (/\.pi\/(?:sdlc-factory|engineering-team)\/expertise/i.test(command)) return A("expertise files are host-owned");
  if (isDangerousRm(command)) return A("destructive rm of a root or home path is never allowed");
  if (isForcePush(command)) return A("force-push is never allowed");
  if (/(?:^|[;&|]\s*)sudo\s/.test(command)) return A("sudo is never allowed");
  if (/(?:npm|pnpm|yarn)\s+publish(?:\s|$)/.test(command)) return A("publish is never allowed");

  for (const segment of splitSegments(command)) {
    const { words, redirects } = tokenize(segment);
    const cmd = stripAssignments(words);
    const verb = cmd[0] ?? "";
    if (verb === "launchctl" && ["load", "unload", "enable", "start", "submit", "kickstart", "bootout"].includes(cmd[1] ?? "")) {
      return A("launchd modification is never allowed");
    }
    if (verb === "systemctl" && ["enable", "disable", "start", "stop", "restart", "daemon-reload", "mask", "unmask", "edit", "link"].includes(cmd[1] ?? "")) {
      return A("systemd modification is never allowed");
    }
    if (verb === "crontab" && !cmd.includes("-l")) return A("crontab modification is never allowed");
    if (verb === "dd" && cmd.some((w) => /^of=\/dev\//.test(w))) return A("writing to a device is never allowed");
    if (
      /^mkfs(\.|$)/.test(verb) || verb === "fdisk" || verb === "parted" || verb === "shred" || verb === "wipefs" ||
      (verb === "diskutil" && cmd.some((w) => /^(erase|partition|reformat|secureErase|zeroDisk|randomDisk)/i.test(w)))
    ) {
      return A("disk formatting is never allowed");
    }
    for (const word of cmd.slice(1)) {
      const hit = protectedWord(word, ctx, env);
      if (hit !== null) return A(`protected path in command: ${hit}`);
    }
    for (const r of redirects) {
      if (!isWriteRedirect(r.op)) continue;
      const hit = protectedWord(r.target, ctx, env);
      if (hit !== null) return A(`write redirect to protected path: ${hit}`);
    }
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
