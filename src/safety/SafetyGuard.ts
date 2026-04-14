// src/safety/SafetyGuard.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SafetyConfig } from "../types.js";
import { classifyCommand } from "./classifier.js";
import { isProtectedPath } from "./paths.js";
import { isPlanModeAllowed } from "./PlanMode.js";
import { verifyToken } from "./approvals.js";
import { readFile } from "fs/promises";
import { join } from "path";

async function loadRunPlanMode(runsDir: string): Promise<boolean> {
  try {
    const activeFile = join(runsDir, "active-run.txt");
    const runId = (await readFile(activeFile, "utf8")).trim();
    const stateFile = join(runsDir, runId, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
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

export function registerSafetyGuard(
  pi: ExtensionAPI,
  config: SafetyConfig & { runsDir: string },
): void {
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const toolName: string = event.tool?.name ?? "";
    const toolInput: Record<string, unknown> = event.toolInput ?? {};

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
          reason: `[Layer B] Plan mode is on — only read-only tools are allowed. Disable with /run-set-plan-mode off`,
          layer: "B",
        };
      }
    }

    // --- Layer C: Default-deny for destructive ---
    if (toolName === "Bash" && typeof toolInput.command === "string") {
      const result = classifyCommand(toolInput.command);
      if (result.classification === "destructive") {
        const { hashArgs } = await import("./approvals.js");
        const argsHash = hashArgs(toolInput as Record<string, unknown>);
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
      const argsHash = hashArgs(toolInput as Record<string, unknown>);
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

    return undefined;
  });
}
