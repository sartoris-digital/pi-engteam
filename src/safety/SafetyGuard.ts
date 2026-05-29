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
import { substituteRunIdInPolicy } from "./teams-config.js";
import { loadSafetyConfigStrict } from "../config.js";
import type { DomainPolicyMap } from "./default-domains.js";
import { inlineOperatorApproval } from "../ui/ConfirmInput.js";
import { CONTROLLER_RUN_ID, recordPendingControllerApproval } from "./controllerApproval.js";

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
  // Codex round-3 HIGH: this function used to catch every error and return
  // false (fail-open), which meant a corrupted or partially-written
  // state.json would silently disable plan-mode enforcement for an active
  // run. Distinguish the two failure shapes:
  //   - ENOENT on active-run.txt → there is no active run → plan-mode is
  //     correctly inert (return false).
  //   - state.json exists but is unreadable / unparseable → we don't know
  //     the planMode status → FAIL CLOSED (return true). The user can
  //     repair state.json or end the run via /run-cancel to recover.
  // Codex round-6 HIGH: prefer PI_ENGINEERING_RUN_ID in subprocess mode so
  // plan-mode enforcement reads run A's state file when run A's worker is
  // executing — even if a sibling controller updated active-run.txt to
  // point at run B in the interim.
  const envRunId = process.env["PI_ENGINEERING_RUN_ID"];
  let runId: string;
  if (envRunId) {
    runId = envRunId;
  } else {
    const activeFile = join(runsDir, "active-run.txt");
    try {
      runId = (await readFile(activeFile, "utf8")).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      // active-run.txt is present but unreadable (EPERM/EACCES) — fail closed.
      return true;
    }
  }
  if (!runId) return false;
  const stateFile = join(runsDir, runId, "state.json");
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state.status !== "running" && state.status !== "waiting_user") return false;
    return state.planMode === true;
  } catch (err) {
    // ENOENT here means active-run.txt referenced a run whose state file is
    // gone — treat as "no active run" rather than fail-closed, since the
    // session is effectively over.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    // JSON parse failure or read failure on an EXISTING file → fail closed.
    return true;
  }
}

async function findValidApproval(
  runsDir: string,
  op: string,
  argsHash: string,
): Promise<boolean> {
  try {
    // Codex round-6 HIGH: previously read active-run.txt unconditionally —
    // a destructive call from run A's subprocess would consult B's
    // approvals if active-run.txt happened to point at B. In subprocess
    // mode, PI_ENGINEERING_RUN_ID is the authoritative run identity;
    // only fall back to active-run.txt for controller-mode callers.
    const envRunId = process.env["PI_ENGINEERING_RUN_ID"];
    let runId: string;
    if (envRunId) {
      runId = envRunId;
    } else {
      const activeFile = join(runsDir, "active-run.txt");
      try {
        runId = (await readFile(activeFile, "utf8")).trim();
      } catch {
        // No active run and no subprocess env — fall back to the _controller
        // pseudo-run context so tokens minted by /approve are honored.
        runId = CONTROLLER_RUN_ID;
      }
    }
    const secretFile = join(runsDir, runId, ".secret");
    const approvalDir = join(runsDir, runId, "approvals");
    const secret = (await readFile(secretFile, "utf8")).trim();

    // Phase 7: read current pauseEpoch so we can reject tokens minted
    // under a different (pre-emergency-stop) epoch even if their
    // signature is otherwise valid. PLAN.md round-A8 HIGH 2.
    // Phase 7 review HIGH (both rounds): fail CLOSED on config load
    // failure. A corrupt safety.json must NOT silently collapse
    // currentPauseEpoch to 0 — that would re-validate every pre-stop
    // token under a forged "fresh epoch" view. Refuse the approval.
    let currentPauseEpoch: number;
    let emergencyStopped = false;
    try {
      const safety = await loadSafetyConfigStrict();
      currentPauseEpoch = safety.approvalWatcher?.pauseEpoch ?? 0;
      if (safety.approvalWatcher?.emergencyStop === true) emergencyStopped = true;
    } catch {
      return false;
    }
    if (emergencyStopped) return false;

    const { readdir, rename } = await import("fs/promises");
    const files = await readdir(approvalDir).catch(() => []);

    for (const file of files) {
      // Codex round-2 HIGH: skip already-consumed tokens at the directory
      // listing level. Consumed once-tokens are renamed to `.consumed` so
      // sibling processes scanning the dir cannot pick them up after the
      // rename has landed. Anything still ending in `.json` is a live token.
      if (!file.endsWith(".json")) continue;
      try {
        const tokenPath = join(approvalDir, file);
        const token = JSON.parse(await readFile(tokenPath, "utf8"));
        if (token.consumed) continue;
        if (token.op !== op) continue;
        if (token.argsHash !== argsHash) continue;
        // Codex round-6 HIGH: bind token to the run it was issued under.
        // verifyToken now includes runId in the HMAC, but defense-in-depth
        // also explicit-compares — a token whose .runId field matches but
        // signature doesn't would fail verifyToken; a token whose runId is
        // missing/wrong (legacy or tampered) is rejected here.
        if (token.runId !== runId) continue;
        if (!verifyToken(secret, token)) continue;
        // Phase 7 (PLAN.md round-A8 HIGH 2): reject tokens whose
        // pauseEpoch differs from the current global pauseEpoch — even
        // if their signature is otherwise valid, they were minted
        // under a stale epoch (pre-emergency-stop) and must not be
        // honored post-resume. verifyToken already enforces
        // pauseEpoch presence + signature match; we layer the strict
        // equality on top so a bumped counter invalidates old tokens
        // without invalidating in-flight fresh ones.
        if (token.pauseEpoch !== currentPauseEpoch) continue;
        if (token.scope === "once") {
          // Codex round-2 HIGH: atomic consume via rename. The previous
          // load-mutate-write sequence let two concurrent tool_call
          // callbacks both observe `consumed=false`, both pass the check,
          // and both proceed — a once-scope approval would be honored
          // twice (double-spend). Atomic rename to `<file>.consumed`
          // serializes via the kernel: the loser sees ENOENT and falls
          // through to the next token (or returns false).
          const consumedPath = tokenPath + ".consumed";
          try {
            await rename(tokenPath, consumedPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              // Someone else just consumed it. Keep scanning — another
              // matching token may exist.
              continue;
            }
            // Any other rename error: refuse the approval rather than
            // double-spend or silently allow.
            continue;
          }
          // Best-effort: stamp the consumed file with the consumed=true
          // flag for audit clarity. Failure does NOT undo consumption.
          try {
            const { writeFile } = await import("fs/promises");
            token.consumed = true;
            await writeFile(consumedPath, JSON.stringify(token, null, 2));
          } catch {
            // best-effort audit only
          }
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
  const rawPolicy = agentName ? domainLock.policies[agentName] : undefined;
  // Surface missing-policy as a warn so misspelled or new agents are visible to operators.
  if (!rawPolicy) {
    domainLock.emitEvent({
      category: "safety",
      type: "domain_warn",
      payload: { agent: agentName || "unknown", reason: "no-policy", tool: toolName },
    });
    return undefined;
  }
  // Per-call `${RUN_ID}` substitution. The teams-config loader resolves
  // `${RUN_DIR}` + `${EXPERTISE_DIR}` at extension boot, but `${RUN_ID}`
  // is delivery-scoped — each agent subprocess sees its own run via
  // `PI_ENGINEERING_RUN_ID`. Without this hop, policies using
  // `${RUN_ID}` (orchestrator + every Lead) match nothing in production
  // (Codex round-1 finding #1).
  //
  // Fail closed when the policy needs `${RUN_ID}` but the env is missing
  // — silently substituting an empty string collapses
  // `<RUN_DIR>/${RUN_ID}/synthesis.md` to `<RUN_DIR>/synthesis.md` and
  // grants cross-run write access (Codex round-1 finding #2).
  const runId = process.env["PI_ENGINEERING_RUN_ID"] || undefined;
  const policy = substituteRunIdInPolicy(rawPolicy, runId);
  if (!policy) {
    domainLock.emitEvent({
      category: "safety",
      type: "domain_block",
      payload: {
        agent: agentName,
        reason: "missing-run-id",
        tool: toolName,
        hint: "policy uses ${RUN_ID} but PI_ENGINEERING_RUN_ID is unset; refusing to apply policy",
      },
    });
    return {
      block: true,
      reason: `[Layer D] policy for '${agentName}' uses \${RUN_ID} but PI_ENGINEERING_RUN_ID is unset; refusing to apply`,
      layer: "D",
    };
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
 * Phase 5.5 round-4 H1: shared Layer A Bash guard used by both
 * registerHardBlockers (subprocess mode) and registerSafetyGuard
 * (controller mode). Returns a block descriptor when the command should
 * be hard-blocked, or undefined to allow downstream layers to evaluate.
 */
function bashLayerAGuard(command: string): { block: true; reason: string; layer: string } | undefined {
  const result = classifyCommand(command);
  if (result.classification === "blocked") {
    return {
      block: true,
      reason: `[Layer A] Blocked: ${result.reason ?? result.rule ?? "hard-block rule matched"}`,
      layer: "A",
    };
  }
  if (/\.pi\/engineering-team\/expertise/i.test(command)) {
    return {
      block: true,
      reason: "[Layer A] Bash command targets expertise files; only Memory Core may write them.",
      layer: "A",
    };
  }
  // Round-4 C1: any tasks.json mention is blocked. The dequoted variant
  // catches concatenation bypasses like `task""s.json`.
  const dequoted = command.replace(/['"`]/g, "");
  if (/tasks\.json/i.test(command) || /tasks\.json/i.test(dequoted)) {
    return {
      block: true,
      reason: "[Layer A] Bash command mentions tasks.json; only the TaskUpdate tool may modify run task ledgers.",
      layer: "A",
    };
  }
  return undefined;
}

/**
 * C2: Layer A hard-blocker registration, extracted so it can be applied in
 * agent subprocess mode as well as controller mode.
 *
 * Codex round-10 CRITICAL: previously this only wired Layers A + D, leaving
 * agent subprocesses able to bypass plan-mode (Layer B) and the approval
 * gate (Layer C). A worker running in a planMode=true run could still
 * Bash destructive commands because registerSafetyGuard's B/C checks
 * lived only in the controller process. Layers B and C are now wired
 * here too when runsDir is configured.
 */
export function registerHardBlockers(
  pi: ExtensionAPI,
  config: Pick<SafetyConfig, "hardBlockers"> & { domainLock?: DomainLockConfig; runsDir?: string },
): void {
  if (!config.hardBlockers.enabled) return;
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const { toolName, toolInput } = normalizeToolEvent(event);

    if (toolName === "Bash" && typeof toolInput.command === "string") {
      const guard = bashLayerAGuard(toolInput.command);
      if (guard) return guard;
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

    // --- Layer B: Plan-mode gate (subprocess) ---
    if (config.runsDir) {
      const planMode = await loadRunPlanMode(config.runsDir);
      if (planMode && !isPlanModeAllowed(toolName, toolInput)) {
        return {
          block: true,
          reason: `[Layer B] Plan mode is on — only read-only tools are allowed. Use /run-plan-mode off to disable.`,
          layer: "B",
        };
      }
    }

    // --- Layer C: Default-deny for destructive (subprocess) ---
    if (config.runsDir && toolName === "Bash" && typeof toolInput.command === "string") {
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
    if (config.runsDir && ["Write", "Edit"].includes(toolName)) {
      const { hashArgs } = await import("./approvals.js");
      const filePath = (toolInput.file_path ?? toolInput.path ?? "") as string;
      const argsHash = hashArgs({ op: toolName.toLowerCase(), command: filePath });
      const approved = await findValidApproval(
        config.runsDir,
        toolName.toLowerCase(),
        argsHash,
      );
      if (!approved) {
        // Controller mode has additional verifier-script-update logic and
        // exempts most writes (defaults to allow when not classified as
        // destructive). Subprocess mode preserves the same shape: only
        // BLOCK if classification says destructive. For simple file writes
        // outside the destructive set, fall through to Layer D.
        // We deliberately do NOT block all Write/Edit here — that would
        // be too strict for legitimate worker writes. The destructive
        // classifier is the source of truth.
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
  pi.on("tool_call", async (event: any, ctx: any) => {
    const { toolName, toolInput } = normalizeToolEvent(event);

    // --- Layer A: Hard blockers ---
    if (config.hardBlockers.enabled) {
      if (toolName === "Bash" && typeof toolInput.command === "string") {
        // Round-4 H1: shared with registerHardBlockers so controller
        // mode gets the same expertise + tasks.json Bash defenses.
        const guard = bashLayerAGuard(toolInput.command);
        if (guard) return guard;
      }

      if (["Write", "Edit", "Read"].includes(toolName)) {
        const filePath = ((toolInput.file_path ?? toolInput.path ?? "") as string);
        if (filePath) {
          // Round-4 H1: pass runsDir so the tasks.json rule honors
          // non-standard runsDir layouts in controller mode too.
          const check = isProtectedPath(filePath, { runsDir: config.runsDir });
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
          const detail = toolInput.command as string;
          if (!(await inlineOperatorApproval(ctx, "destructive command", detail))) {
            if (!process.env["PI_ENGINEERING_RUN_ID"]) {
              try {
                await recordPendingControllerApproval(config.runsDir, { op: "bash", argsHash, display: detail });
              } catch { /* best-effort; never changes the block decision */ }
            }
            return {
              block: true,
              reason: `[Layer C] Destructive command requires Judge approval. Call RequestApproval first — or run /approve to authorize.`,
              layer: "C",
              classifierRule: result.reason,
            };
          }
          // operator approved inline — allow this call (fall through)
          console.warn(`[pi-engineering] Layer C: operator approved destructive command inline — ${detail}`);
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
          if (!(await inlineOperatorApproval(ctx, `${toolName} on active verifier-script`, filePath))) {
            if (!process.env["PI_ENGINEERING_RUN_ID"]) {
              try {
                const vsArgsHash = hashArgs({ op: "verifier-script-update", command: filePath });
                await recordPendingControllerApproval(config.runsDir, { op: "verifier-script-update", argsHash: vsArgsHash, display: filePath });
              } catch { /* best-effort; never changes the block decision */ }
            }
            return {
              block: true,
              reason: `[Layer C] ${toolName} on active verifier-script requires a verifier-script-update approval token. Stage the change under .staging/ and let the Learner orchestrator promote it — or run /approve to authorize.`,
              layer: "C",
            };
          }
          // operator approved inline — allow this call (fall through)
          console.warn(`[pi-engineering] Layer C: operator approved ${toolName} on active verifier-script inline — ${filePath}`);
        }
      } else {
        const argsHash = hashArgs({ op: toolName.toLowerCase(), command: filePath });
        const approved = await findValidApproval(
          config.runsDir,
          toolName.toLowerCase(),
          argsHash,
        );
        if (!approved) {
          if (!(await inlineOperatorApproval(ctx, toolName, filePath))) {
            if (!process.env["PI_ENGINEERING_RUN_ID"]) {
              try {
                await recordPendingControllerApproval(config.runsDir, { op: toolName.toLowerCase(), argsHash, display: filePath });
              } catch { /* best-effort; never changes the block decision */ }
            }
            return {
              block: true,
              reason: `[Layer C] ${toolName} requires Judge approval. Call RequestApproval first — or run /approve to authorize.`,
              layer: "C",
            };
          }
          // operator approved inline — allow this call (fall through)
          console.warn(`[pi-engineering] Layer C: operator approved ${toolName} inline — ${filePath}`);
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
