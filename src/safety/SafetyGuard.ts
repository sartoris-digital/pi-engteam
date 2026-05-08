// src/safety/SafetyGuard.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SafetyConfig } from "../types.js";
import { classifyCommand } from "./classifier.js";
import { isProtectedPath } from "./paths.js";
import { isPlanModeAllowed } from "./PlanMode.js";
import { verifyToken } from "./approvals.js";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { checkDomain } from "./DomainLock.js";
import type { DomainPolicyMap } from "./default-domains.js";

// Pi 0.67 emits ToolCallEvent with `toolName` (lowercase: "bash"|"read"|"edit"|
// "write"|"grep"|"find"|"ls"|<custom>) and `input` (typed input object). All
// safety layers were originally written against an older shape (`event.tool.name`
// / `event.toolInput`). normalizeToolEvent reads both shapes and returns the
// canonical capitalized name used throughout safety code.
const BUILTIN_TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Find",
  ls: "Ls",
};

export function normalizeToolEvent(event: any): {
  toolName: string;
  toolInput: Record<string, unknown>;
} {
  const rawName = (event?.toolName ?? event?.tool?.name ?? "") as string;
  const input = (event?.input ?? event?.toolInput ?? {}) as Record<string, unknown>;
  const canonical = BUILTIN_TOOL_NAME_MAP[rawName.toLowerCase()] ?? rawName;
  return { toolName: canonical, toolInput: input };
}

async function loadRunPlanMode(runsDir: string): Promise<boolean> {
  try {
    const activeFile = join(runsDir, "active-run.txt");
    const runId = (await readFile(activeFile, "utf8")).trim();
    const stateFile = join(runsDir, runId, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    // Only enforce plan mode for actively running workflows — not for ended/failed/succeeded runs
    if (state.status !== "running" && state.status !== "waiting_user") return false;
    return state.planMode === true;
  } catch {
    return false;
  }
}

async function findValidApproval(
  runsDir: string,
  op: string,
  argsHash: string,
): Promise<boolean> {
  try {
    const activeFile = join(runsDir, "active-run.txt");
    const runId = (await readFile(activeFile, "utf8")).trim();
    const secretFile = join(runsDir, runId, ".secret");
    const approvalDir = join(runsDir, runId, "approvals");
    const secret = (await readFile(secretFile, "utf8")).trim();

    const { readdir } = await import("fs/promises");
    const files = await readdir(approvalDir).catch(() => []);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const tokenPath = join(approvalDir, file);
        const token = JSON.parse(await readFile(tokenPath, "utf8"));
        if (token.consumed) continue;
        if (token.op !== op) continue;
        if (token.argsHash !== argsHash) continue;
        if (!verifyToken(secret, token)) continue;
        if (token.scope === "once") {
          token.consumed = true;
          const { writeFile } = await import("fs/promises");
          await writeFile(tokenPath, JSON.stringify(token, null, 2));
        }
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

type DomainLockConfig = {
  policies: DomainPolicyMap;
  mode: "warn" | "block";
  emitEvent: (evt: { category: "safety"; type: string; payload: Record<string, unknown> }) => void;
};

async function applyLayerD(
  toolName: string,
  toolInput: Record<string, unknown>,
  domainLock: DomainLockConfig,
): Promise<{ block: true; reason: string; layer: string; [k: string]: unknown } | undefined> {
  if (!["Write", "Edit", "Bash", "Read", "Grep", "Glob", "Find", "Ls"].includes(toolName)) return undefined;
  const agentName = process.env["PI_ENGINEERING_AGENT_NAME"] ?? "";
  const policy = agentName ? domainLock.policies[agentName] : undefined;
  // Surface missing-policy as a warn so misspelled or new agents are visible to operators.
  if (!policy) {
    domainLock.emitEvent({
      category: "safety",
      type: "domain_warn",
      payload: { agent: agentName || "unknown", reason: "no-policy", tool: toolName },
    });
    return undefined;
  }
  const filePath = (toolInput.file_path ?? toolInput.path ?? toolInput.pattern_path ?? "") as string;
  const result = checkDomain({
    agent: agentName,
    operation: toolName as "Read" | "Write" | "Edit" | "Bash" | "Grep" | "Glob" | "Find" | "Ls",
    path: filePath || undefined,
    command: typeof toolInput.command === "string" ? toolInput.command : undefined,
    policy,
    mode: domainLock.mode,
  });
  if (!result.allowed) {
    domainLock.emitEvent({
      category: "safety",
      type: result.mode === "block" ? "domain_block" : "domain_warn",
      payload: result.structured,
    });
    if (result.mode === "block") {
      return {
        ...result.structured,
        block: true,
        reason: `[Layer D] ${result.reason}`,
        layer: "D",
      };
    }
    // warn mode: emit event but allow operation to proceed
  }
  return undefined;
}

/**
 * C2: Layer A hard-blocker registration, extracted so it can be applied in
 * agent subprocess mode as well as controller mode.
 */
export function registerHardBlockers(
  pi: ExtensionAPI,
  config: Pick<SafetyConfig, "hardBlockers"> & { domainLock?: DomainLockConfig; runsDir?: string },
): void {
  if (!config.hardBlockers.enabled) return;
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const { toolName, toolInput } = normalizeToolEvent(event);

    if (toolName === "Bash" && typeof toolInput.command === "string") {
      const result = classifyCommand(toolInput.command);
      if (result.classification === "blocked") {
        return {
          block: true,
          reason: `[Layer A] Blocked: ${result.reason ?? result.rule ?? "hard-block rule matched"}`,
          layer: "A",
        };
      }
      // Phase 5 round-2 C1 + round-3 C1: Bash bypass of the expertise
      // single-writer policy. The match is now case-insensitive (defense
      // against macOS HFS+ case-folded paths) and matches both forward
      // slashes and the unlikely-but-possible double-slash variant. This
      // catches `mv ... ./.pi/engineering-team/expertise/eng.md`,
      // `cp .../EXPERTISE/...`, `tee >> .pi/engineering-team/expertise/foo`,
      // and similar.
      //
      // Round-3 C1 caveat: this guard cannot catch shell-variable
      // indirection (`mv "$tmp/forged.md" "$EXP/eng.md"` where EXP is
      // set in a prior call), command substitution, or other dynamic
      // expansion. The defense-in-depth is the per-agent DomainLock
      // policy at Layer D — every worker agent's default force_block list
      // includes the expertise dir, so even a Write/Edit/Bash that does
      // reach disk is rejected by Pi's tool-call boundary if the worker's
      // domain lock is enforced.
      if (/\.pi\/engineering-team\/expertise/i.test(toolInput.command)) {
        return {
          block: true,
          reason: "[Layer A] Bash command targets expertise files; only Memory Core may write them.",
          layer: "A",
        };
      }
      // Phase 5.5 round-3 C1: same defense for tasks.json. classifier.ts
      // treats redirects as 'destructive' (Judge-approvable), not
      // 'blocked'. A worker could otherwise `echo '[]' >
      // /runs/abc/tasks.json` or `tee >> .../tasks.json`, bypassing
      // TaskUpdate's taskId validation. Match any Bash command that
      // mentions a tasks.json under a /runs/ path.
      if (/(?:\/runs\/|\/engineering-team\/runs\/)[^\s'"`]*\/tasks\.json/i.test(toolInput.command)
          || /tasks\.json/i.test(toolInput.command) && /(?:\/runs\/|\/engineering-team\/runs\/)/i.test(toolInput.command)) {
        return {
          block: true,
          reason: "[Layer A] Bash command targets a run's tasks.json; only the TaskUpdate tool may modify it.",
          layer: "A",
        };
      }
    }

    if (["Write", "Edit", "Read"].includes(toolName)) {
      const filePath = ((toolInput.file_path ?? toolInput.path ?? "") as string);
      if (filePath) {
        const check = isProtectedPath(filePath, { runsDir: config.runsDir });
        if (check.blocked) {
          return { block: true, reason: `[Layer A] Protected path: ${check.reason}`, layer: "A" };
        }
      }
    }

    // --- Layer D: Domain lock ---
    if (config.domainLock) {
      return applyLayerD(toolName, toolInput, config.domainLock);
    }

    return undefined;
  });
}

export function registerSafetyGuard(
  pi: ExtensionAPI,
  config: SafetyConfig & { runsDir: string; domainLock?: DomainLockConfig },
): void {
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const { toolName, toolInput } = normalizeToolEvent(event);

    // --- Layer A: Hard blockers ---
    if (config.hardBlockers.enabled) {
      if (toolName === "Bash" && typeof toolInput.command === "string") {
        const result = classifyCommand(toolInput.command);
        if (result.classification === "blocked") {
          return {
            block: true,
            reason: `[Layer A] Blocked: ${result.reason ?? result.rule ?? "hard-block rule matched"}`,
            layer: "A",
          };
        }
      }

      if (["Write", "Edit", "Read"].includes(toolName)) {
        const filePath = ((toolInput.file_path ?? toolInput.path ?? "") as string);
        if (filePath) {
          const check = isProtectedPath(filePath);
          if (check.blocked) {
            return {
              block: true,
              reason: `[Layer A] Protected path: ${check.reason}`,
              layer: "A",
            };
          }
        }
      }
    }

    // --- Layer B: Plan-mode gate ---
    const planMode = await loadRunPlanMode(config.runsDir);
    if (planMode) {
      if (!isPlanModeAllowed(toolName, toolInput)) {
        return {
          block: true,
          reason: `[Layer B] Plan mode is on — only read-only tools are allowed. Use /run-plan-mode off to disable.`,
          layer: "B",
        };
      }
    }

    // --- Layer C: Default-deny for destructive ---
    // C1: hash must match GrantApproval's token format: { op, command }
    if (toolName === "Bash" && typeof toolInput.command === "string") {
      const result = classifyCommand(toolInput.command);
      if (result.classification === "destructive") {
        const { hashArgs } = await import("./approvals.js");
        const argsHash = hashArgs({ op: "bash", command: toolInput.command as string });
        const approved = await findValidApproval(config.runsDir, "bash", argsHash);
        if (!approved) {
          return {
            block: true,
            reason: `[Layer C] Destructive command requires Judge approval. Call RequestApproval first.`,
            layer: "C",
            classifierRule: result.reason,
          };
        }
      }
    }

    if (["Write", "Edit"].includes(toolName)) {
      const { hashArgs } = await import("./approvals.js");
      // C1: use the file path as "command" to match what GrantApproval.ts stores
      const filePath = (toolInput.file_path ?? toolInput.path ?? "") as string;

      // Phase 3.5: writes to active verifier-scripts/ (NOT .staging/) require a
      // Judge-approved verifier-script-update token. Promotion goes through the
      // Learner orchestrator's atomic rename — direct Write/Edit by any agent
      // hits this gate. .staging/ is intentionally exempt (Learner writes there
      // via Layer D); .fixtures/ and .versions/ are also exempt — fixture and
      // archive churn is part of the orchestrator's normal flow.
      const expandedPath = filePath.startsWith("~/")
        ? join(homedir(), filePath.slice(2))
        : filePath;
      const verifierScriptsRoot = join(homedir(), ".pi", "engineering-team", "verifier-scripts");
      const isActiveVerifierScript =
        expandedPath.startsWith(verifierScriptsRoot + "/") &&
        !expandedPath.startsWith(join(verifierScriptsRoot, ".staging") + "/") &&
        !expandedPath.startsWith(join(verifierScriptsRoot, ".versions") + "/") &&
        !expandedPath.startsWith(join(verifierScriptsRoot, ".fixtures") + "/");

      if (isActiveVerifierScript) {
        const argsHash = hashArgs({ op: "verifier-script-update", command: filePath });
        const approved = await findValidApproval(
          config.runsDir,
          "verifier-script-update",
          argsHash,
        );
        if (!approved) {
          return {
            block: true,
            reason: `[Layer C] ${toolName} on active verifier-script requires a verifier-script-update approval token. Stage the change under .staging/ and let the Learner orchestrator promote it.`,
            layer: "C",
          };
        }
      } else {
        const argsHash = hashArgs({ op: toolName.toLowerCase(), command: filePath });
        const approved = await findValidApproval(
          config.runsDir,
          toolName.toLowerCase(),
          argsHash,
        );
        if (!approved) {
          return {
            block: true,
            reason: `[Layer C] ${toolName} requires Judge approval. Call RequestApproval first.`,
            layer: "C",
          };
        }
      }
    }

    // --- Layer D: Domain lock ---
    if (config.domainLock) {
      return applyLayerD(toolName, toolInput, config.domainLock);
    }

    return undefined;
  });
}
