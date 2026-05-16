import { watch, createReadStream, statSync } from "fs";
import { readdir } from "fs/promises";
import { dirname, join } from "path";
import type { Db } from "./storage.js";
import { ensureRunExists, insertEvent, upsertRun } from "./storage.js";
import type { EngteamEvent } from "../src/types.js";

// Codex round-7 HIGH: previously the watcher tracked offsets keyed only by
// path. When EventWriter rotated events.jsonl → events.1.jsonl, the
// watcher kept reading from the new (smaller) file at the old offset and
// any tail data that landed in the rotated file was lost. Now track inode
// alongside offset so we can detect rotation; when the inode at
// events.jsonl changes, drain the prior inode's file (renamed to
// events.N.jsonl) from the saved offset before resetting.
type FileState = { offset: number; ino: number };

const ROTATED_FILE_RE = /^events\.(\d+)\.jsonl$/;

export class EventWatcher {
  private fileStates = new Map<string, FileState>();
  // inode → which rotated path we know it lives under (best-effort; new
  // rotations re-index numbering so we re-resolve when needed).
  private watchers: ReturnType<typeof watch>[] = [];

  constructor(
    private runsDir: string,
    private db: Db,
  ) {}

  async start(): Promise<void> {
    await this.scanDir(this.runsDir);

    try {
      const w = watch(this.runsDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (filename.endsWith("events.jsonl") || ROTATED_FILE_RE.test(filename.split("/").pop() ?? "")) {
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
        } else if (entry.name === "events.jsonl" || ROTATED_FILE_RE.test(entry.name)) {
          await this.ingestFile(full);
        }
      }
    } catch {
      // directory may not exist yet — ignore
    }
  }

  // Find the rotated file in the same dir that has the given inode (the
  // writer renames events.jsonl → events.1.jsonl on rotation, bumping all
  // existing events.N.jsonl). We scan once on demand.
  private findRotatedPathForInode(parentDir: string, ino: number): string | null {
    try {
      const { readdirSync } = require("fs") as typeof import("fs");
      for (const entry of readdirSync(parentDir)) {
        if (!ROTATED_FILE_RE.test(entry)) continue;
        const full = join(parentDir, entry);
        try {
          const s = statSync(full);
          if (s.ino === ino) return full;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return null;
  }

  async ingestFile(filePath: string): Promise<void> {
    const prior = this.fileStates.get(filePath);

    let fileSize = 0;
    let ino = 0;
    try {
      const s = statSync(filePath);
      fileSize = s.size;
      ino = s.ino;
    } catch {
      return;
    }

    // Rotation detection: same path, different inode → the old inode was
    // renamed away. Drain its tail from the saved offset before resetting.
    if (prior && prior.ino && prior.ino !== ino) {
      const rotatedPath = this.findRotatedPathForInode(dirname(filePath), prior.ino);
      if (rotatedPath) {
        // Use the prior offset on the renamed file (same inode, so the
        // same byte offset still points at the same content).
        const drainState: FileState = { offset: prior.offset, ino: prior.ino };
        this.fileStates.set(rotatedPath, drainState);
        await this.drain(rotatedPath, drainState);
      }
      // Reset the canonical path's state — start fresh on the new file.
      this.fileStates.delete(filePath);
    }

    const state = this.fileStates.get(filePath) ?? { offset: 0, ino };
    state.ino = ino;

    if (fileSize <= state.offset) return;
    await this.drain(filePath, state);
  }

  private async drain(filePath: string, state: FileState): Promise<void> {
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
