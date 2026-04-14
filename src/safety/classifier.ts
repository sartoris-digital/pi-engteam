// src/safety/classifier.ts
import { parse as shellParse } from "shell-quote";
import type { ClassifierResult } from "../types.js";
import {
  isDangerousRm, isForcePush, isSudo, isPublish,
  isLaunchdWrite, isDeviceWrite,
} from "./patterns.js";
import { isProtectedPath } from "./paths.js";

const SAFE_VERBS = new Set([
  "cat", "bat", "less", "more", "head", "tail", "wc", "file", "stat", "xxd", "od",
  "grep", "rg", "ag", "fd",
  "ls", "la", "ll", "tree", "dir",
  "sort", "uniq", "cut", "tr", "jq", "yq", "diff", "comm",
  "pwd", "whoami", "hostname", "uname", "date", "printenv", "which", "type",
  "ps", "df", "du", "top",
  "vitest", "jest", "mocha", "tap", "ava",
  "pytest", "py.test",
  "tsc", "pyright", "mypy", "eslint", "rubocop",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "shortlog",
  "branch", "tag", "remote", "rev-parse", "ls-files",
  "config", "describe", "reflog", "stash", "worktree",
  "submodule", "cat-file", "check-ignore",
]);

const SAFE_NPM_SUBCOMMANDS = new Set(["test", "run", "view", "ls", "list", "info", "outdated", "audit"]);
const SAFE_PNPM_SUBCOMMANDS = new Set(["test", "run", "list", "view", "why", "audit"]);
const SAFE_MAKE_FLAGS = new Set(["-n", "--dry-run", "--just-print"]);
const SAFE_CARGO_SUBCOMMANDS = new Set([
  "test", "check", "clippy", "doc", "bench", "tree", "search", "info", "report", "audit",
]);

function splitCompound(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (inSingle || inDouble) { current += ch; continue; }

    if (ch === "(" || ch === "{") { depth++; current += ch; continue; }
    if (ch === ")" || ch === "}") { depth--; current += ch; continue; }

    if (depth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (ch === "|" || ch === ";") {
        segments.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.filter(Boolean);
}

function classifySegment(segment: string): ClassifierResult {
  const trimmed = segment.trim();
  if (!trimmed) return { classification: "safe" };

  if (isDangerousRm(trimmed)) return { classification: "blocked", rule: "dangerous-rm" };
  if (isForcePush(trimmed)) return { classification: "blocked", rule: "force-push" };
  if (isSudo(trimmed)) return { classification: "blocked", rule: "sudo" };
  if (isPublish(trimmed)) return { classification: "blocked", rule: "publish" };
  if (isLaunchdWrite(trimmed)) return { classification: "blocked", rule: "launchd-systemd" };
  if (isDeviceWrite(trimmed)) return { classification: "blocked", rule: "device-write" };

  // chmod on a protected system path is blocked
  const chmodMatch = trimmed.match(/^chmod\s+\S+\s+(\S+)/);
  if (chmodMatch) {
    const check = isProtectedPath(chmodMatch[1]);
    if (check.blocked) return { classification: "blocked", rule: "chmod-protected-path", reason: check.reason };
  }

  // Check all path-like tokens for env file or protected path access
  const pathTokenMatches = trimmed.matchAll(/(?:^|\s)((?:~\/|\/)?(?:[^\s]*\/)?\.env(?!\.(?:sample|example))(?:\.[a-zA-Z0-9._-]+)?)/g);
  for (const match of pathTokenMatches) {
    const path = match[1];
    const check = isProtectedPath(path);
    if (check.blocked) return { classification: "blocked", rule: "env-file", reason: check.reason };
  }

  let tokens: string[];
  try {
    const parsed = shellParse(trimmed);
    tokens = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return { classification: "destructive", reason: "shell parse failed, defaulting to destructive" };
  }

  if (tokens.length === 0) return { classification: "safe" };

  const verb = tokens[0].toLowerCase();
  const subcommand = tokens[1]?.toLowerCase();

  if (verb === "git") {
    if (!subcommand) return { classification: "safe" };
    if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) return { classification: "safe" };
    return { classification: "destructive", reason: `git ${subcommand} is not in safe subcommand list` };
  }

  if (verb === "npm") {
    if (!subcommand) return { classification: "safe" };
    if (SAFE_NPM_SUBCOMMANDS.has(subcommand)) return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "pnpm") {
    if (!subcommand) return { classification: "safe" };
    if (SAFE_PNPM_SUBCOMMANDS.has(subcommand)) return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "yarn") {
    if (!subcommand) return { classification: "safe" };
    if (subcommand === "test" || subcommand === "audit" || subcommand === "list") return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "cargo") {
    if (!subcommand) return { classification: "safe" };
    if (SAFE_CARGO_SUBCOMMANDS.has(subcommand)) return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "go") {
    if (subcommand === "test" || subcommand === "vet" || subcommand === "doc") return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "make") {
    if (tokens.some(t => SAFE_MAKE_FLAGS.has(t))) return { classification: "safe" };
    return { classification: "destructive" };
  }

  if (verb === "find") {
    if (
      tokens.includes("-delete") ||
      (tokens.includes("-exec") && tokens.some(t => t === "rm"))
    ) {
      return { classification: "destructive", reason: "find with -delete or -exec rm" };
    }
    return { classification: "safe" };
  }

  if (verb === "sed") {
    if (tokens.some(t => t === "-i" || t.startsWith("-i") || t === "--in-place")) {
      return { classification: "destructive", reason: "sed -i (in-place edit)" };
    }
    return { classification: "safe" };
  }

  if (verb === "awk") {
    if (tokens.some(t => t === "-i" || t === "--inplace" || t === "inplace")) {
      return { classification: "destructive", reason: "awk -i inplace (in-place edit)" };
    }
    return { classification: "safe" };
  }

  if (verb === "perl") {
    if (tokens.some(t => t.includes("-i"))) {
      return { classification: "destructive", reason: "perl -i (in-place edit)" };
    }
    return { classification: "safe" };
  }

  if (verb === "python" || verb === "python3" || verb === "node") {
    return { classification: "destructive", reason: "script execution" };
  }

  const rawParsed = shellParse(trimmed);
  const hasRedirect = rawParsed.some(t => typeof t === "object" && t !== null && "op" in (t as object));
  if (hasRedirect) {
    const redirectTargets = rawParsed
      .filter((t): t is Record<string, string> => typeof t === "object" && t !== null)
      .map((t) => (t as Record<string, string>).file ?? "");
    const toFile = redirectTargets.some(f => f && !f.match(/^[012]$/));
    if (toFile) return { classification: "destructive", reason: "redirect to file" };
  }

  if (SAFE_VERBS.has(verb)) return { classification: "safe" };

  return { classification: "destructive", reason: `unknown verb '${verb}', defaulting to destructive` };
}

export function classifyCommand(command: string): ClassifierResult {
  const segments = splitCompound(command);
  let worstResult: ClassifierResult = { classification: "safe" };

  for (const segment of segments) {
    const result = classifySegment(segment);
    if (result.classification === "blocked") return result;
    if (result.classification === "destructive") worstResult = result;
  }

  return worstResult;
}
