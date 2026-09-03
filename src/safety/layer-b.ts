import { resolve } from "node:path";
import { classifyBash } from "./classifier.js";
import type { Block, RunContext } from "./context.js";
import { defaultPathEnv, expandHome, isUnder, realish, type PathEnv } from "./paths.js";

export const STAGE_CLASS_BY_AGENT: Readonly<Record<string, "read-only" | "writer">> = {
  "issue-analyst": "read-only",
  planner: "read-only",
  architect: "read-only",
  tester: "writer",
  implementer: "writer",
  reviewer: "read-only",
  "security-auditor": "read-only",
  judge: "read-only",
  verifier: "read-only",
  "root-cause-debugger": "read-only",
  discoverer: "read-only",
  "codebase-cartographer": "read-only",
  codifier: "writer",
};

export const READ_ONLY_STAGE_CLASSES: ReadonlySet<string> = new Set(
  Object.entries(STAGE_CLASS_BY_AGENT).filter(([, cls]) => cls === "read-only").map(([agent]) => agent),
);

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "find", "ls", "VerdictEmit", "RequestApproval", "AskHost"]);

export function stageClassOf(agent: string): "read-only" | "writer" {
  return STAGE_CLASS_BY_AGENT[agent] ?? "read-only";
}

export function readOnlyBlock(tool: string, input: Record<string, unknown>, ctx: RunContext, env: PathEnv = defaultPathEnv()): Block | null {
  if (stageClassOf(ctx.agent) !== "read-only") return null;
  const B = (detail: string): Block => ({
    block: true,
    layer: "B",
    reason: `[Layer B] read-only stage "${ctx.stage}" (${ctx.agent}): ${detail}`,
  });
  if (READ_ONLY_TOOLS.has(tool)) return null;
  if (tool === "bash") {
    const command = input.command;
    if (typeof command !== "string") return B("bash without a command");
    const c = classifyBash(command, { cwd: ctx.workspaceDir });
    return c.class === "safe" ? null : B(`${c.reason}; only read-only commands are allowed in this stage`);
  }
  if (tool === "write" || tool === "edit") {
    const p = input.path;
    if (typeof p !== "string" || p.length === 0) return B(`${tool} without a path`);
    const abs = realish(resolve(ctx.workspaceDir, expandHome(p, env.home)));
    if (isUnder(abs, realish(resolve(ctx.runDir)))) return null;
    return B(`${tool} to ${p} is outside the run directory; this stage may only write its run-dir artifacts`);
  }
  return B(`tool "${tool}" is not available in a read-only stage`);
}
