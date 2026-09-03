import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadRunState, saveRunState } from "../engine/state.js";
import { acquireDaemonLease } from "./lease.js";
import { readQueue, writeQueue } from "./queue.js";

export interface RecoverFactoryOptions {
  runsDir: string;
  now?: () => Date;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  acquireLease?: typeof acquireDaemonLease;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function pauseRunningEngineRuns(runsDirPath: string): Promise<string[]> {
  let entries: { name: string; isDirectory(): boolean }[] = [];
  try {
    entries = await readdir(runsDirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const recovered: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "_factory") continue;
    const state = await loadRunState(runsDirPath, entry.name);
    if (state === null || state.status !== "running") continue;
    state.status = "paused";
    state.updatedAt = new Date().toISOString();
    await saveRunState(runsDirPath, state);
    recovered.push(entry.name);
  }
  return recovered;
}

async function killOrphans(runsDir: string, kill: (pid: number, signal: NodeJS.Signals) => void): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of entries) {
    if (name === "_factory") continue;
    try {
      const raw = JSON.parse(await readFile(join(runsDir, name, "_children.json"), "utf8")) as unknown;
      const rows = Array.isArray(raw) ? raw : [];
      for (const row of rows) {
        if (row === null || typeof row !== "object") continue;
        const pid = (row as { pid?: unknown }).pid;
        if (typeof pid !== "number") continue;
        kill(pid, "SIGTERM");
        n += 1;
      }
    } catch {
      /* no registry */
    }
  }
  return n;
}

export async function recoverFactory(opts: RecoverFactoryOptions): Promise<{ recovered: string[]; orphansKilled: number }> {
  const recovered = await pauseRunningEngineRuns(opts.runsDir);
  const acquire = opts.acquireLease ?? acquireDaemonLease;
  const lease = await acquire(opts.runsDir);
  let orphansKilled = 0;
  try {
    if (opts.kill !== undefined) orphansKilled = await killOrphans(opts.runsDir, opts.kill);
    if (!lease.holder) return { recovered, orphansKilled };
    const queue = await readQueue(opts.runsDir);
    const now = (opts.now ?? (() => new Date()))().toISOString();
    let dirty = false;
    for (const entry of queue.entries) {
      if (entry.state !== "running" || entry.workspace?.path === undefined) continue;
      if (await exists(entry.workspace.path)) continue;
      entry.state = "blocked";
      entry.updatedAt = now;
      entry.escalations = [...(entry.escalations ?? []), { code: "workspace-lost", at: now, detail: entry.workspace.path }];
      dirty = true;
      if (entry.runId !== undefined) {
        const state = await loadRunState(opts.runsDir, entry.runId);
        if (state !== null) {
          state.escalation = {
            code: "workspace-lost",
            detail: `workspace missing: ${entry.workspace.path}`,
            at: now,
            step: state.currentStep,
          };
          await saveRunState(opts.runsDir, state);
        }
      }
    }
    if (dirty) await writeQueue(opts.runsDir, queue);
    return { recovered, orphansKilled };
  } finally {
    await lease.stop();
  }
}
