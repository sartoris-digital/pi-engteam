// src/safety/PlanMode.ts
import { classifyCommand } from "./classifier.js";

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "Read", "Grep", "Glob", "LSP",
]);

export function isPlanModeAllowed(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) return true;
  if (toolName === "Bash") {
    const command = toolInput.command as string | undefined;
    if (!command) return false;
    const result = classifyCommand(command);
    return result.classification === "safe";
  }
  return false;
}
