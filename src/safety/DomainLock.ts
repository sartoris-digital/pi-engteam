// src/safety/DomainLock.ts
// SafetyGuard Layer D: domain locking. Verifies the agent's declared upsert/delete
// roots permit Write/Edit/Bash targets; bash is additionally constrained when the
// agent's policy declares `bash_policy: script-only`.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { realpathSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import type { DomainPolicy } from "./default-domains.js";

export type DomainOperation = "Read" | "Write" | "Edit" | "Bash";

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

function realResolve(p: string): string {
  const abs = resolve(expandHome(p));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isUnderRoot(target: string, root: string): boolean {
  const realTarget = realResolve(target);
  const realRoot = realResolve(root);
  if (realTarget === realRoot) return true;
  return realTarget.startsWith(realRoot.endsWith("/") ? realRoot : realRoot + "/");
}

function pathAllowed(target: string, roots: string[]): boolean {
  for (const r of roots) {
    if (isUnderRoot(target, r)) return true;
  }
  return false;
}

function buildHint(operation: DomainOperation, target: string, agent: string): string {
  return (
    `${target} is outside ${agent}'s ${operation === "Bash" ? "bash" : "domain"}. To proceed: ` +
    `(a) ask the relevant lead to delegate to an agent with permission for this path, ` +
    `(b) add the path to ${agent}.upsert in teams.local.yaml, or ` +
    `(c) request judge approval via RequestApproval to bypass for this run.`
  );
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

  // Agent has no policy entry: caller is responsible for emitting a warn event.
  if (!policy) return { allowed: true };

  if (operation === "Read") {
    if (!path) return { allowed: true };
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
    if (pathAllowed(path, policy.upsert) || pathAllowed(path, policy.delete)) {
      return { allowed: true };
    }
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
        allowed_paths: { upsert: policy.upsert, delete: policy.delete },
        hint: buildHint(operation, path, agent),
      },
    };
  }

  if (operation === "Bash") {
    if (!policy.bash_policy) return { allowed: true }; // Layer C handles
    if (!command) {
      return {
        allowed: false,
        mode,
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
        mode,
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
      // Glob support: only trailing `*` matched as a prefix; otherwise exact path equality.
      if (allowed.endsWith("/*.py")) {
        const prefix = expandHome(allowed.slice(0, -"*.py".length));
        const realScript = realResolve(scriptToken);
        return realScript.startsWith(prefix) && realScript.endsWith(".py");
      }
      return realResolve(scriptToken) === realResolve(allowed);
    });
    if (matched) return { allowed: true };
    return {
      allowed: false,
      mode,
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
    const toolName: string = event.tool?.name ?? "";
    if (!["Read", "Write", "Edit", "Bash"].includes(toolName)) return undefined;

    const toolInput: Record<string, unknown> = event.toolInput ?? {};
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

    const filePath = (toolInput.file_path ?? toolInput.path ?? "") as string;
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

    if (opts.mode === "warn") {
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
