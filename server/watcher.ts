import { watch, createReadStream, statSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import type { Db } from "./storage.js";
import { ensureRunExists, insertEvent, upsertRun } from "./storage.js";
import type { EngteamEvent } from "../src/types.js";

type FileState = { offset: number };

export class EventWatcher {
  private fileStates = new Map<string, FileState>();
  private watchers: ReturnType<typeof watch>[] = [];

  constructor(
    private runsDir: string,
    private db: Db,
  ) {}

  async start(): Promise<void> {
    await this.scanDir(this.runsDir);

    try {
      const w = watch(this.runsDir, { recursive: true }, (_event, filename) => {
        if (filename?.endsWith("events.jsonl")) {
          const fullPath = join(this.runsDir, filename);
          void this.ingestFile(fullPath);
        }
      });
      this.watchers.push(w);
    } catch {
      // fs.watch with recursive not supported on all platforms — fall back to polling
      const interval = setInterval(() => { void this.scanDir(this.runsDir); }, 2000);
      // Store interval as a fake watcher so stop() can clear it
      this.watchers.push({ close: () => clearInterval(interval) } as any);
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  private async scanDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.scanDir(full);
        } else if (entry.name === "events.jsonl") {
          await this.ingestFile(full);
        }
      }
    } catch {
      // directory may not exist yet — ignore
    }
  }

  async ingestFile(filePath: string): Promise<void> {
    const state = this.fileStates.get(filePath) ?? { offset: 0 };

    let fileSize = 0;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      return;
    }

    if (fileSize <= state.offset) return;

    let newContent = "";
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, {
        start: state.offset,
        encoding: "utf8",
      });
      stream.on("data", (chunk) => { newContent += chunk; });
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    // Split on newlines — last segment may be a partial line
    const parts = newContent.split("\n");
    const completeLines = parts.slice(0, -1);
    // parts[last] is "" if content ended with \n, or a fragment otherwise

    // Advance offset only by bytes of complete content consumed
    const consumed = completeLines.join("\n") + (completeLines.length > 0 ? "\n" : "");
    state.offset += Buffer.byteLength(consumed, "utf8");
    this.fileStates.set(filePath, state);

    const lines = completeLines.filter(line => line.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as EngteamEvent;
        ensureRunExists(this.db, event.runId, event.ts);
        insertEvent(this.db, {
          runId: event.runId,
          ts: event.ts,
          category: event.category,
          type: event.type,
          step: event.step,
          agentName: event.agentName,
          summary: event.summary,
          payload: event.payload,
        });

        // Sync run metadata from lifecycle events
        if (
          event.category === "lifecycle" &&
          (event.type === "run.start" || event.type === "run.end")
        ) {
          const p = event.payload as any;
          upsertRun(this.db, {
            runId: event.runId,
            workflow: p.workflow ?? "unknown",
            goal: p.goal ?? "",
            status: event.type === "run.end" ? (p.status ?? "succeeded") : "running",
            currentStep: p.currentStep,
            iteration: p.iteration ?? 0,
            createdAt: event.ts,
            updatedAt: event.ts,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }
  }
}
