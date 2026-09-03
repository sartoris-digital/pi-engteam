import { resolve } from "node:path";
import { classifyBash, type Classification } from "./classifier.js";
import type { Block, RunContext } from "./context.js";
import { defaultPathEnv, expandHome, isUnder, realish, type PathEnv } from "./paths.js";
import { hashArgs, type TokenSource } from "./tokens.js";

export const NO_TOKENS: TokenSource = { take: () => null };

const C = (reason: string): Block => ({ block: true, layer: "C", reason: `[Layer C] ${reason}` });

export function defaultDenyBlock(
  tool: string,
  input: Record<string, unknown>,
  ctx: RunContext,
  tokens: TokenSource,
  env: PathEnv = defaultPathEnv(),
): Block | null {
  if (tool === "bash" || tool === "powershell") {
    const command = input.command;
    if (typeof command !== "string") return C(`${tool} call without a command`);
    const classification: Classification =
      tool === "bash" ? classifyBash(command, { cwd: ctx.workspaceDir }) : { class: "destructive", reason: "powershell is never classified safe" };
    if (classification.class === "safe") return null;
    const argsHash = hashArgs("bash", { command });
    if (tokens.take("bash", argsHash) !== null) return null;
    return C(
      `destructive command needs a once-scope approval token (${classification.reason}). ` +
        'Call RequestApproval with op "bash" and this exact command, then emit NEEDS_MORE with flags ["approval-needed"].',
    );
  }
  if (tool === "write" || tool === "edit") {
    const p = input.path;
    if (typeof p !== "string" || p.length === 0) return C(`${tool} without a path`);
    const abs = realish(resolve(ctx.workspaceDir, expandHome(p, env.home)));
    if (isUnder(abs, realish(resolve(ctx.workspaceDir))) || isUnder(abs, realish(resolve(ctx.runDir)))) return null;
    const argsHash = hashArgs(tool, { path: abs });
    if (tokens.take(tool, argsHash) !== null) return null;
    return C(
      `${tool} outside the worktree and run directory (${abs}) needs a once-scope approval token. ` +
        `Call RequestApproval with op "${tool}" and this path, then emit NEEDS_MORE with flags ["approval-needed"].`,
    );
  }
  return null;
}
