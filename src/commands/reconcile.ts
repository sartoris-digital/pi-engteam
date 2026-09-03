import { loadEffectiveConfig } from "../config/effective.js";
import { DEFAULTS } from "../config/defaults.js";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { landReconcile } from "../git/reconcile.js";
import { readQueue, writeQueue, type QueueEntry } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

async function baseFor(entry: QueueEntry, deps: FactoryDeps): Promise<string> {
  try {
    const cfg = await loadEffectiveConfig(entry.repo, { home: deps.home });
    return cfg.repo.branching.base;
  } catch {
    return "main";
  }
}

export async function runReconcile(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<QueueEntry[]> {
  const repoFilter = typeof parsed.flags.repo === "string" ? parsed.flags.repo : parsed.args[0];
  const queue = await readQueue(deps.runsDir);
  const published = queue.entries.filter(
    (e) => e.state === "published" && (repoFilter === undefined || e.repo === repoFilter),
  );
  const updated: QueueEntry[] = [];
  for (const entry of published) {
    const cwd = entry.repo;
    const out = await landReconcile(entry, {
      cwd,
      base: await baseFor(entry, deps),
      abandonDays: DEFAULTS.operator.abandonDays,
      runsDir: deps.runsDir,
      others: published,
    });
    updated.push(out);
  }
  await writeQueue(deps.runsDir, queue);
  return updated;
}
