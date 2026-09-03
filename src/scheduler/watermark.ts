import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function watermarkPath(runsDir: string, trackerId: string): string {
  return join(runsDir, "_factory", "trackers", `${trackerId}.json`);
}

export async function readWatermark(runsDir: string, trackerId: string): Promise<{ updatedSince?: string } | null> {
  try {
    const raw = JSON.parse(await readFile(watermarkPath(runsDir, trackerId), "utf8")) as { updatedSince?: unknown };
    if (typeof raw.updatedSince === "string") return { updatedSince: raw.updatedSince };
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeWatermark(runsDir: string, trackerId: string, at: string): Promise<void> {
  const path = watermarkPath(runsDir, trackerId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ updatedSince: at }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
