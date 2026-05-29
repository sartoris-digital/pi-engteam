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
      // A bare `|` that immediately follows a `>` (ignoring whitespace) is the
      // clobber half of a `>|` redirect, NOT a pipe. Splitting there would tear
      // the redirect from its target and let `safeverb >| file` slip through as
      // two safe segments. Treat it as a literal so the redirect walk sees it.
      if (ch === "|" && /(?:^|[^|>])>\s*$/.test(current)) {
        current += ch;
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

  if (verb === "gh") {
    if (!subcommand) return { classification: "safe" };
    const safeGhObjects = new Set(["issue", "pr", "repo"]);
    if (safeGhObjects.has(subcommand)) {
      const action = tokens[2]?.toLowerCase();
      if (action === "view" || action === "list" || action === "show") return { classification: "safe" };
    }
    return { classification: "destructive", reason: `gh ${subcommand} ${tokens[2] ?? ""} is not in safe subcommand list` };
  }

  if (verb === "az") {
    if (!subcommand) return { classification: "safe" };
    const readOnlyAzObjects = new Set(["boards", "repos"]);
    if (readOnlyAzObjects.has(subcommand)) {
      const hasWrite = tokens.some(t => ["create", "update", "delete", "set", "add", "remove"].includes(t.toLowerCase()));
      if (!hasWrite) return { classification: "safe" };
    }
    return { classification: "destructive", reason: `az ${subcommand} is not in safe subcommand list or contains write operation` };
  }

  if (verb === "jira") {
    if (!subcommand) return { classification: "safe" };
    if (subcommand === "issue") {
      const action = tokens[2]?.toLowerCase();
      if (action === "view" || action === "list") return { classification: "safe" };
    }
    return { classification: "destructive", reason: `jira ${subcommand} ${tokens[2] ?? ""} is not in safe subcommand list` };
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

  // xargs runs another command on each input. Classify by the WRAPPED verb
  // so `xargs grep` / `xargs head` / `xargs wc` compose with safe-verb
  // semantics, while `xargs rm` / `xargs sh` still go through the normal
  // destructive checks. Without this, every `find … | xargs <safe> …`
  // pipeline got classified destructive because `xargs` wasn't a known
  // verb — the Codex round-11 16 KB cap exposed this when agents started
  // exploring large codebases.
  if (verb === "xargs") {
    let i = 1;
    // Skip xargs's own flags: -0, -n N, -I {}, --null, --max-args N, etc.
    // Treat any token starting with `-` (and its argument if expected) as
    // part of xargs's own option set.
    const flagsWithArg = new Set(["-n", "--max-args", "-I", "--replace", "-L", "--max-lines", "-P", "--max-procs", "-E", "-d", "--delimiter"]);
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const flag = tokens[i];
      i++;
      if (flagsWithArg.has(flag) && i < tokens.length && !tokens[i].startsWith("-")) {
        i++; // consume the flag's argument
      }
    }
    if (i >= tokens.length) {
      // Bare `xargs` with no wrapped command — input is just echoed.
      return { classification: "safe" };
    }
    const wrappedSegment = tokens.slice(i).join(" ");
    return classifySegment(wrappedSegment);
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
  // shell-quote emits a redirect operator as { op: ">" } with the target as the
  // NEXT token (the old code read a non-existent `.file` field, so write
  // redirects were never detected). Walk the tokens: a WRITE redirect whose
  // target is a real file — not a fd dup (2>&1) and not /dev/null & friends —
  // is destructive. Writing a file via redirect must be gated like the Write tool.
  const HARMLESS_REDIRECT_TARGETS = new Set([
    "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty",
  ]);
  for (let i = 0; i < rawParsed.length; i++) {
    const tok = rawParsed[i];
    if (typeof tok !== "object" || tok === null || !("op" in (tok as object))) continue;
    const op = String((tok as { op: string }).op);
    // Only WRITE redirects. Matches: > >> >| &> &>> and fd-numbered forms like 2> 2>>.
    // Excludes input redirects (< <<) and fd-dup ops (>& <&), which don't write a file.
    const isWriteRedirect = /^(\d*>>?|>\||&>>?)$/.test(op);
    if (!isWriteRedirect) continue;
    // Find the target token. shell-quote splits ">|" (clobber) into
    // { op:">" }{ op:"|" }, so skip an intervening { op:"|" } to reach the file.
    let target: unknown = undefined;
    for (let j = i + 1; j < rawParsed.length; j++) {
      const t = rawParsed[j];
      if (typeof t === "string") { target = t; break; }
      if (typeof t === "object" && t !== null && "op" in (t as object) && String((t as { op: string }).op) === "|") {
        continue; // part of >| clobber redirect
      }
      break; // any other op (or end) → this redirect has no file target
    }
    if (typeof target !== "string") continue;
    if (/^&?\d+$/.test(target)) continue;             // fd dup target (e.g. >&1)
    if (HARMLESS_REDIRECT_TARGETS.has(target)) continue;
    return { classification: "destructive", reason: "redirect to file" };
  }

  if (SAFE_VERBS.has(verb)) return { classification: "safe" };

  return { classification: "destructive", reason: `unknown verb '${verb}', defaulting to destructive` };
}

// Codex round-11 MEDIUM: cap command length BEFORE regex/shell parsing.
// A 10MB command would otherwise pin the event loop while regexes and
// shellParse walked it. Real Bash commands are <1KB; 16KB is generous.
// Commands above the cap are classified as "destructive" so the approval
// gate fires, rather than silently allowed or blocked.
const MAX_COMMAND_BYTES = 16 * 1024;

export function classifyCommand(command: string): ClassifierResult {
  if (typeof command === "string" && command.length > MAX_COMMAND_BYTES) {
    return {
      classification: "destructive",
      reason: `command exceeds ${MAX_COMMAND_BYTES} bytes; refusing to classify without approval`,
    };
  }
  const segments = splitCompound(command);
  let worstResult: ClassifierResult = { classification: "safe" };

  for (const segment of segments) {
    const result = classifySegment(segment);
    if (result.classification === "blocked") return result;
    if (result.classification === "destructive") worstResult = result;
  }

  return worstResult;
}
