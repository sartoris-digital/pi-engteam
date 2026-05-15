import { appendFile, mkdir, rename, stat, readdir } from "fs/promises";
import { join } from "path";
import type { EngteamEvent } from "../types.js";

const DEFAULT_ROTATION_BYTES = 50 * 1024 * 1024; // 50MB

export class EventWriter {
  // Codex round-3 MEDIUM #4: rotateIfNeeded reads size, then renames a
  // sequence of files. Two concurrent write() calls both saw size over
  // threshold and both ran rename loops — the second loop tried to rename
  // files the first had already moved, dropping events and yielding torn
  // event.N.jsonl numbering. Serialize all writes per-runId through an
  // in-process queue chain so rotate runs once and writes append after.
  private writeQueues = new Map<string, Promise<unknown>>();

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
  }

  async write(runId: string, event: EngteamEvent): Promise<void> {
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
