// src/v3/merge-queue.ts — enqueue repo auto-merge; never git merge / gh pr merge without --auto.
import type { RunState } from "../engine/types.js";
import { v3Enabled, type V3HostConfig } from "./dispatch.js";

export interface MayEnqueueInput {
  cfg: V3HostConfig;
  kind: RunState["kind"];
  tier: RunState["tier"];
  touchesRisk: boolean;
  capabilities: ReadonlySet<string>;
}

export interface MergeQueueAdapter {
  enqueueMergeQueue?(pr: { url: string }): Promise<{ queued: boolean; detail: string }>;
}

export class DirectMergeError extends Error {
  readonly code = "direct-merge" as const;
  constructor(message: string) {
    super(message);
    this.name = "DirectMergeError";
  }
}

export function mayEnqueueMergeQueue(input: MayEnqueueInput): boolean {
  if (!v3Enabled(input.cfg, "mergeQueue")) return false;
  if (input.kind !== "chore") return false;
  if (input.tier !== "low") return false;
  if (input.touchesRisk) return false;
  return input.capabilities.has("mergeQueue");
}

/** Throws if argv would perform a direct merge instead of enabling the repo merge queue. */
export function assertAutoMergeArgv(argv: readonly string[]): void {
  const tokens = argv.map((a) => a.toLowerCase());
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const has = (t: string): boolean => tokens.includes(t);
  const isPrMerge = has("pr") && has("merge");
  const isMrMerge = has("mr") && has("merge");
  const isGitMerge =
    !isPrMerge && !isMrMerge && (tokens[0] === "git" || tokens[0] === "merge") && has("merge");

  if (isGitMerge) {
    throw new DirectMergeError("direct git merge is forbidden; enqueue auto-merge instead");
  }
  if (isPrMerge && !flags.has("--auto") && !flags.has("--auto-merge")) {
    throw new DirectMergeError("gh pr merge requires --auto");
  }
  if (isMrMerge && !flags.has("--auto-merge") && !flags.has("--when-pipeline-succeeds") && !flags.has("--auto")) {
    throw new DirectMergeError("glab mr merge requires --auto-merge");
  }
}

export async function enqueueMergeQueue(
  adapter: MergeQueueAdapter,
  pr: { url: string },
  argvLog?: string[][],
): Promise<{ queued: boolean; detail: string }> {
  if (argvLog !== undefined) {
    for (const argv of argvLog) assertAutoMergeArgv(argv);
  }
  if (adapter.enqueueMergeQueue === undefined) return { queued: false, detail: "unsupported" };
  return adapter.enqueueMergeQueue(pr);
}

export async function maybeEnqueue(
  input: MayEnqueueInput & { adapter: MergeQueueAdapter; pr: { url: string }; argvLog?: string[][] },
): Promise<{ queued: boolean; detail: string }> {
  if (!mayEnqueueMergeQueue(input)) return { queued: false, detail: "policy-denied" };
  return enqueueMergeQueue(input.adapter, input.pr, input.argvLog);
}
