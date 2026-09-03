import type { FactoryDeps } from "../controller/lane-runner.js";
import type { Workspace } from "../workspace/types.js";
import { runCancel } from "./cancel.js";
import { findQueueEntry, readQueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runDrop(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<{ ref: string; removed: boolean }> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("drop: missing ref");
  await runCancel(parsed, deps);
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined || entry.workspace === undefined) return { ref, removed: false };
  const ws = entry.workspace;
  const workspace = {
    provider: "git" as const,
    path: ws.path,
    branch: ws.branch,
    baseSha: "",
    repoRoot: entry.repo,
    gitCommonDir: ws.path,
    configSha: "",
  } satisfies Workspace;
  await deps.provider.remove(workspace, { force: false });
  return { ref: entry.ref, removed: true };
}
