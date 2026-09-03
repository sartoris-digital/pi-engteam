import { DEFAULTS } from "../config/defaults.js";
import type { FactoryDeps } from "../controller/lane-runner.js";
import type { Workspace } from "../workspace/types.js";
import { readQueue, writeQueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runGc(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<{ removed: number }> {
  const days = typeof parsed.flags.days === "string" ? Number(parsed.flags.days) : DEFAULTS.operator.gcDays;
  const cutoff = Date.now() - days * 86_400_000;
  const queue = await readQueue(deps.runsDir);
  let removed = 0;
  for (const entry of queue.entries) {
    if (entry.state !== "closed") continue;
    if (Date.parse(entry.updatedAt) > cutoff) continue;
    const ws = entry.workspace;
    if (ws === undefined) continue;
    const workspace = {
      provider: "git" as const,
      path: ws.path,
      branch: ws.branch,
      baseSha: "",
      repoRoot: entry.repo,
      gitCommonDir: ws.path,
      configSha: "",
    } satisfies Workspace;
    await deps.provider.remove(workspace, { force: true });
    delete entry.workspace;
    entry.updatedAt = new Date().toISOString();
    removed += 1;
  }
  await writeQueue(deps.runsDir, queue);
  return { removed };
}
