// src/safety/DomainLock.ts
// SafetyGuard Layer D: domain locking. Verifies the agent's declared upsert/delete
// roots permit Write/Edit/Bash targets; bash is additionally constrained when the
// agent's policy declares `bash_policy: script-only`.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { realpathSync, existsSync } from "fs";
import { homedir } from "os";
import { resolve, dirname, sep } from "path";
import { parse as shellParse } from "shell-quote";
import { normalizeToolEvent } from "./SafetyGuard.js";
import type { DomainPolicy } from "./default-domains.js";

export type DomainOperation = "Read" | "Write" | "Edit" | "Bash" | "Grep" | "Glob" | "Find" | "Ls";

export type DomainLockResult =
  | { allowed: true }
  | {
      allowed: false;
      mode: "warn" | "block";
      reason: string;
      structured: Record<string, unknown>;
    };

function expandHome(p: string): string {
  if (p.startsWith("~/")) return p.replace("~", homedir());
  if (p === "~") return homedir();
  return p;
}

// Resolves symlinks via the nearest existing ancestor, then re-appends the
// non-existent remainder. Defends against (1) symlinked parents that escape the
// declared root, and (2) writes to files that don't exist yet (realpathSync
// would fail for those and a naive fallback to the unresolved abs path could
// allow ../escape sequences after a symlinked dir).
function realResolve(p: string): string {
  let abs = resolve(expandHome(p));
  // Walk up to the nearest existing ancestor.
  let cursor = abs;
  const segments: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    segments.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }
  let resolved: string;
  try {
    resolved = realpathSync(cursor);
  } catch {
    resolved = cursor;
  }
  for (const seg of segments) resolved = resolved + sep + seg;
  return resolved;
}

function isUnderRoot(target: string, root: string): boolean {
  const realTarget = realResolve(target);
  const realRoot = realResolve(root);
  if (realTarget === realRoot) return true;
  return realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

function pathAllowed(target: string, roots: string[]): boolean {
  for (const r of roots) {
    if (isUnderRoot(target, r)) return true;
  }
  return false;
}

function rejectTraversal(
  agent: string,
  operation: DomainOperation,
  path: string,
  mode: "warn" | "block",
  allowed: Record<string, string[]>,
): DomainLockResult {
  return {
    allowed: false,
    mode,
    reason: "domain-lock",
    structured: {
      block: true,
      reason: "domain-lock",
      agent,
      operation,
      path,
      allowed_paths: allowed,
      hint: `${path} contains '..' segments. Agent paths must be canonical absolute or project-relative paths without parent-traversal.`,
    },
  };
}

function buildHint(operation: DomainOperation, target: string, agent: string): string {
  return (
    `${target} is outside ${agent}'s ${operation === "Bash" ? "bash" : "domain"}. To proceed: ` +
    `(a) ask the relevant lead to delegate to an agent with permission for this path, ` +
    `(b) add the path to ${agent}.upsert in teams.local.yaml, or ` +
    `(c) request judge approval via RequestApproval to bypass for this run.`
  );
}

// Compound-command detection: parse with shell-quote (already a dep, used by
// classifier.ts) and reject if any operator token appears. Operator tokens are
// returned by shell-quote as plain objects ({ op: ';' } etc.) or comment
// objects. Backslash-escape gymnastics ("\\;", "\\$(...)") that defeat naive
// regex scanners get parsed by shell-quote into proper operator objects when
// they actually function as shell operators.
function hasCompoundOperators(remainder: string): boolean {
  if (remainder.trim() === "") return false;
  // Newline is a shell command separator that shell-quote does NOT tokenize as
  // an op. Bare newlines, CR, or process-substitution `<(...)` / `>(...)` after
  // the allowed script must be rejected before we even hand to shell-quote.
  if (/[\n\r]/.test(remainder)) return true;
  if (/<\(|>\(/.test(remainder)) return true;
  // Here-strings and here-docs.
  if (/<<</.test(remainder) || /<<-?/.test(remainder)) return true;
  let parsed: ReturnType<typeof shellParse>;
  try {
    parsed = shellParse(remainder);
  } catch {
    return true;
  }
  for (const tok of parsed) {
    if (typeof tok === "object" && tok !== null && "op" in tok) {
      return true;
    }
  }
  const joined = parsed.filter((t): t is string => typeof t === "string").join(" ");
  if (/\$\(|`|\$\{[^}]*[?:][^}]*\}/.test(joined)) return true;
  return false;
}

// Reject paths containing `..` segments. path.resolve collapses `..` lexically
// BEFORE we get a chance to realpath each component, which means a symlinked
// parent followed by `..` could escape the allowed root via lexical
// normalization. Forbidding `..` in agent-supplied paths is the simplest
// correct guard.
function containsParentTraversal(p: string): boolean {
  const expanded = expandHome(p);
  const segments = expanded.split(sep);
  return segments.includes("..");
}

export function checkDomain(opts: {
  agent: string;
  operation: DomainOperation;
  path?: string;
  command?: string;
  policy: DomainPolicy | undefined;
  mode: "warn" | "block";
}): DomainLockResult {
  const { agent, operation, path, command, policy, mode } = opts;

  // Phase 5 round-4 C1: GLOBAL force-block on the expertise dirs that runs
  // ahead of every per-agent policy check. Layer A's isProtectedPath
  // already handles Write/Edit/Read with file paths and Bash with literal
  // path substrings, but a worker's Bash command without a bash_policy
  // would otherwise reach this path with operation="Bash" and be allowed
  // through (line ~210). Block here unconditionally — only the host
  // process's MemoryCore writes expertise files, and that path doesn't
  // flow through the Pi tool boundary.
  const expertisePathRegex = /\.pi\/engineering-team\/expertise/i;
  if (operation === "Write" || operation === "Edit") {
    if (path && expertisePathRegex.test(path)) {
      return {
        allowed: false,
        mode: "block",
        reason: "domain-lock",
        structured: {
          block: true,
          reason: "domain-lock",
          agent,
          operation,
          path,
          allowed_paths: {},
          hint: "Expertise files are curated by Memory Core only. Workers MUST NOT write to .pi/engineering-team/expertise — emit wisdom via VerdictEmit's learnings/decisions/issues_found/gotchas fields instead.",
        },
      };
    }
  }
  if (operation === "Bash" && command && expertisePathRegex.test(command)) {
    return {
      allowed: false,
      mode: "block",
      reason: "domain-lock",
      structured: {
        block: true,
        reason: "domain-lock",
        agent,
        operation,
        command,
        allowed_paths: {},
        hint: "Bash command targets expertise files. Workers MUST NOT modify .pi/engineering-team/expertise — emit wisdom via VerdictEmit instead.",
      },
    };
  }

  // Agent has no policy entry: caller is responsible for emitting a warn event.
  if (!policy) return { allowed: true };

  if (operation === "Read" || operation === "Grep" || operation === "Glob" || operation === "Find" || operation === "Ls") {
    if (!path) return { allowed: true };
    if (containsParentTraversal(path)) {
      return rejectTraversal(agent, operation, path, mode, { read: policy.read });
    }
    if (pathAllowed(path, policy.read)) return { allowed: true };
    return {
      allowed: false,
      mode,
      reason: "domain-lock",
      structured: {
        block: true,
        reason: "domain-lock",
        agent,
        operation,
        path,
        allowed_paths: { read: policy.read },
        hint: buildHint(operation, path, agent),
      },
    };
  }

  if (operation === "Write" || operation === "Edit") {
    if (!path) return { allowed: true };
    if (containsParentTraversal(path)) {
      return rejectTraversal(agent, operation, path, policy.force_block ? "block" : mode, { upsert: policy.upsert, delete: policy.delete });
    }
    // Only `upsert` grants write/edit. `delete` is a separate verb and
    // must NOT imply write permission (Codex round 1 MEDIUM #3).
    if (pathAllowed(path, policy.upsert)) {
      return { allowed: true };
    }
    // force_block agents (verifier-style security model) always block on
    // path-domain violations regardless of global mode. Codex P3.5 round-1 C-1.
    const enforcedMode = policy.force_block ? "block" : mode;
    return {
      allowed: false,
      mode: enforcedMode,
      reason: "domain-lock",
      structured: {
        block: true,
        reason: "domain-lock",
        agent,
        operation,
        path,
        allowed_paths: { upsert: policy.upsert, delete: policy.delete },
        hint: buildHint(operation, path, agent),
      },
    };
  }

  if (operation === "Bash") {
    if (!policy.bash_policy) return { allowed: true }; // Layer C handles
    // Agents declaring bash_policy: script-only have a security model that
    // depends on enforcement. We override the caller's "warn" mode here so
    // these agents are ALWAYS blocked on policy violations, regardless of
    // the global teams.yaml mode. (Codex round-1 P3 C-1.)
    const enforcedMode = "block";
    if (!command) {
      return {
        allowed: false,
        mode: enforcedMode,
        reason: "domain-lock",
        structured: {
          block: true,
          reason: "domain-lock",
          agent,
          operation,
          command,
          allowed_paths: {
            bash_runner: policy.bash_policy.runner,
            allowed_scripts: policy.bash_policy.allowed_scripts,
          },
          hint: `${agent} bash is restricted to script-only mode.`,
        },
      };
    }
    const runner = policy.bash_policy.runner;
    const trimmed = command.trim();
    if (!trimmed.startsWith(runner + " ")) {
      return {
        allowed: false,
        mode: enforcedMode,
        reason: "domain-lock",
        structured: {
          block: true,
          reason: "domain-lock",
          agent,
          operation,
          command,
          allowed_paths: {
            bash_runner: runner,
            allowed_scripts: policy.bash_policy.allowed_scripts,
          },
          hint: `${agent} bash must start with '${runner}' followed by an allowed script.`,
        },
      };
    }
    const remainder = trimmed.slice(runner.length + 1).trim();
    const scriptToken = remainder.split(/\s+/)[0] ?? "";
    const matched = policy.bash_policy.allowed_scripts.some((allowed) => {
      // Glob support: only trailing `*.py` matched as a prefix; otherwise exact equality.
      if (allowed.endsWith("/*.py")) {
        const prefix = expandHome(allowed.slice(0, -"*.py".length));
        const realScript = realResolve(scriptToken);
        return realScript.startsWith(prefix) && realScript.endsWith(".py");
      }
      return realResolve(scriptToken) === realResolve(allowed);
    });
    if (!matched) {
      return {
        allowed: false,
        mode: enforcedMode,
        reason: "domain-lock",
        structured: {
          block: true,
          reason: "domain-lock",
          agent,
          operation,
          command,
          allowed_paths: {
            bash_runner: runner,
            allowed_scripts: policy.bash_policy.allowed_scripts,
          },
          hint: `${agent} may only run scripts in ${policy.bash_policy.allowed_scripts.join(", ")}.`,
        },
      };
    }
    // Reject compound commands and shell-metacharacter chaining after the
    // allowed script (Codex round 1 CRITICAL #2). Anything that looks like
    // ;, &&, ||, |, $(, backtick, or a redirect is grounds for rejection.
    const tail = remainder.slice(scriptToken.length);
    if (hasCompoundOperators(tail)) {
      return {
        allowed: false,
        mode: enforcedMode,
        reason: "domain-lock",
        structured: {
          block: true,
          reason: "domain-lock",
          agent,
          operation,
          command,
          allowed_paths: {
            bash_runner: runner,
            allowed_scripts: policy.bash_policy.allowed_scripts,
          },
          hint: `${agent} bash rejects compound commands. Allowed shape: '${runner} <script> [args...]' with no ';', '&&', '|', '$()', backticks, or redirects.`,
        },
      };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

export type DomainEvent = {
  category: "safety";
  type: "domain_block" | "domain_warn";
  payload: Record<string, unknown>;
};

/** Wires Layer D into pi.on("tool_call"). Must be registered AFTER Layers A/B/C. */
export function registerDomainLock(
  pi: ExtensionAPI,
  opts: {
    getPolicyForAgent: () => DomainPolicy | undefined;
    mode: "warn" | "block";
    emitEvent: (evt: DomainEvent) => void;
  },
): void {
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const { toolName, toolInput } = normalizeToolEvent(event);
    if (!["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Find", "Ls"].includes(toolName)) return undefined;

    const agent = process.env["PI_ENGINEERING_AGENT_NAME"] ?? "unknown";
    const policy = opts.getPolicyForAgent();

    if (!policy) {
      opts.emitEvent({
        category: "safety",
        type: "domain_warn",
        payload: { agent, reason: "no-policy", tool: toolName },
      });
      return undefined;
    }

    const filePath = (toolInput.file_path ?? toolInput.path ?? toolInput.pattern_path ?? "") as string;
    const command = (toolInput.command ?? "") as string;

    const result = checkDomain({
      agent,
      operation: toolName as DomainOperation,
      path: filePath || undefined,
      command: command || undefined,
      policy,
      mode: opts.mode,
    });

    if (result.allowed) return undefined;

    // Use the result's mode, not the caller-supplied mode. checkDomain may
    // have promoted to "block" via policy.force_block or bash_policy. Codex
    // P3.5 round-2 NC-1: opts.mode-only branching silently downgraded force-
    // block returns to warn.
    if (result.mode === "warn") {
      opts.emitEvent({
        category: "safety",
        type: "domain_warn",
        payload: result.structured,
      });
      return undefined;
    }

    opts.emitEvent({
      category: "safety",
      type: "domain_block",
      payload: result.structured,
    });
    return {
      block: true,
      reason: `[Layer D] ${result.reason}`,
      layer: "D",
      structured: result.structured,
    };
  });
}
