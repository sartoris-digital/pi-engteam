import { appendFile, mkdir, rename, stat, readdir } from "fs/promises";
import { join } from "path";
import type { EngteamEvent } from "../types.js";

const DEFAULT_ROTATION_BYTES = 50 * 1024 * 1024; // 50MB

export class EventWriter {
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
    await this.ensureDir(runId);
    await this.rotateIfNeeded(runId);
    const line = JSON.stringify(event) + "\n";
    await appendFile(this.getPath(runId), line, "utf8");
  }

  async flush(_runId: string): Promise<void> {
    // appendFile is synchronous at OS level; placeholder for explicit flush calls
  }
}
