import { appendFile } from "fs/promises";
import { join } from "path";
import type { EngteamEvent } from "../types.js";

const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 2000;

export class HttpSink {
  private queue: EngteamEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private url: string,
    private runId: string,
    private runDir: string,
  ) {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  enqueue(event: EngteamEvent): void {
    this.queue.push(event);
    if (this.queue.length >= BATCH_SIZE) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const body = batch.map(e => JSON.stringify(e)).join("\n") + "\n";

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body,
      });
      if (!res.ok) {
        await this.queueToFile(batch);
      }
    } catch {
      await this.queueToFile(batch);
    }
  }

  private async queueToFile(events: EngteamEvent[]): Promise<void> {
    const queuePath = join(this.runDir, "events.sink-queue.jsonl");
    const lines = events.map(e => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(queuePath, lines, "utf8").catch(() => {});
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
