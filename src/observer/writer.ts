import { appendFile, mkdir, rename, stat, readdir, unlink } from "fs/promises";
import { join } from "path";
import type { EngteamEvent } from "../types.js";

const DEFAULT_ROTATION_BYTES = 50 * 1024 * 1024; // 50MB
// Codex round-11 HIGH: cap the number of rotated event files per run.
// Without a retention policy, events.N.jsonl rotated forever and could
// fill the disk. Keep the most recent MAX_ROTATED_FILES rotated files
// and delete the rest on each rotation.
const MAX_ROTATED_FILES = 10;
// Codex round-11 HIGH: cap per-run write queue depth so a slow disk
// can't grow an unbounded chain of pending promises.
const MAX_QUEUE_DEPTH = 1000;

export class EventWriter {
  // Codex round-3 MEDIUM #4: rotateIfNeeded reads size, then renames a
  // sequence of files. Two concurrent write() calls both saw size over
  // threshold and both ran rename loops — the second loop tried to rename
  // files the first had already moved, dropping events and yielding torn
  // event.N.jsonl numbering. Serialize all writes per-runId through an
  // in-process queue chain so rotate runs once and writes append after.
  private writeQueues = new Map<string, Promise<unknown>>();
  // Codex round-11 HIGH: per-run queue depth tracking so we can shed
  // load when a slow disk causes the chain to grow unboundedly.
  private writeDepth = new Map<string, number>();
  // Codex round-15 MEDIUM: track drops separately from queue depth so
  // depth drains naturally when disk pressure subsides.
  private writeDrops = new Map<string, number>();

  constructor(
    private runsDir: string,
    private rotationBytes = DEFAULT_ROTATION_BYTES,
  ) {}

  getPath(runId: string): string {
    return join(this.runsDir, runId, "events.jsonl");
  }

  private async ensureDir(runId: string): Promise<void> {
    await mkdir(join(this.runsDir, runId), { recursive: true });
  }

  private async rotateIfNeeded(runId: string): Promise<void> {
    const main = this.getPath(runId);
    let size = 0;
    try {
      const s = await stat(main);
      size = s.size;
    } catch {
      return;
    }
    if (size < this.rotationBytes) return;

    const dir = join(this.runsDir, runId);
    const files = (await readdir(dir)).filter(f => f.match(/^events\.\d+\.jsonl$/));
    const nums = files.map(f => parseInt(f.replace("events.", "").replace(".jsonl", ""), 10));
    nums.sort((a, b) => b - a);
    for (const n of nums) {
      await rename(join(dir, `events.${n}.jsonl`), join(dir, `events.${n + 1}.jsonl`));
    }
    await rename(main, join(dir, "events.1.jsonl"));

    // Codex round-11 HIGH: enforce retention. After rotation, delete any
    // rotated file whose index exceeds MAX_ROTATED_FILES. Reads from the
    // dashboard cap at events.1.jsonl..events.10.jsonl; anything beyond
    // would only consume disk.
    const post = (await readdir(dir)).filter(f => f.match(/^events\.\d+\.jsonl$/));
    for (const f of post) {
      const n = parseInt(f.replace("events.", "").replace(".jsonl", ""), 10);
      if (Number.isFinite(n) && n > MAX_ROTATED_FILES) {
        try { await unlink(join(dir, f)); } catch { /* best-effort */ }
      }
    }
  }

  async write(runId: string, event: EngteamEvent): Promise<void> {
    // Codex round-11 HIGH: shed load when queue depth crosses MAX_QUEUE_DEPTH.
    // Under disk pressure the chain otherwise grows without bound, holding
    // every queued event object in memory. Dropping is preferable to OOM —
    // surface a single error per overflow so operators see it.
    //
    // Codex round-15 MEDIUM: don't increment writeDepth on the drop path.
    // The finalizer only decrements for COMPLETED writes; previously a
    // dropped write also +1'd depth without enqueueing a finalizer, so
    // the counter never drained and every future write was dropped
    // permanently. Track drops in a separate counter so the cap is
    // self-healing once disk pressure passes.
    const depth = this.writeDepth.get(runId) ?? 0;
    if (depth >= MAX_QUEUE_DEPTH) {
      const drops = (this.writeDrops.get(runId) ?? 0) + 1;
      this.writeDrops.set(runId, drops);
      if (drops % 1000 === 1) {
        console.error(
          `[observer] write queue depth ${depth} for run ${runId} — dropping events under disk pressure (drops=${drops}).`,
        );
      }
      return;
    }
    this.writeDepth.set(runId, depth + 1);
    const prev = this.writeQueues.get(runId) ?? Promise.resolve();
    const next = prev.then(async () => {
      await this.ensureDir(runId);
      await this.rotateIfNeeded(runId);
      const line = JSON.stringify(event) + "\n";
      await appendFile(this.getPath(runId), line, "utf8");
    }, async () => {
      // Prior write rejected — proceed with this one rather than block forever.
      await this.ensureDir(runId);
      await this.rotateIfNeeded(runId);
      const line = JSON.stringify(event) + "\n";
      await appendFile(this.getPath(runId), line, "utf8");
    });
    const tracked = next.catch(() => undefined);
    this.writeQueues.set(runId, tracked);
    // Drop the entry once settled IF no later writer has chained on top.
    void tracked.finally(() => {
      const d = (this.writeDepth.get(runId) ?? 1) - 1;
      if (d <= 0) {
        this.writeDepth.delete(runId);
        // Codex round-16 LOW: writeDrops accumulated one entry per
        // overflowed run for the writer's lifetime. Clear it now that
        // the queue has drained — drops are not meaningful once writes
        // are landing again.
        this.writeDrops.delete(runId);
      } else {
        this.writeDepth.set(runId, d);
      }
      if (this.writeQueues.get(runId) === tracked) {
        this.writeQueues.delete(runId);
      }
    });
    return next;
  }

  async flush(runId: string): Promise<void> {
    // Wait for any in-flight write to settle; appendFile is otherwise
    // synchronous at OS level so we don't need an explicit fsync.
    const pending = this.writeQueues.get(runId);
    if (pending) {
      try { await pending; } catch { /* drained by caller's own write */ }
    }
  }
}
