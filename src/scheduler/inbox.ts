import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function inboxDir(runsDir: string): string {
  return join(runsDir, "_factory", "inbox");
}

export async function enqueueInbox(runsDir: string, request: unknown): Promise<string> {
  const id = randomUUID();
  const dir = inboxDir(runsDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${process.hrtime.bigint().toString()}-${id}.json`;
  await writeFile(join(dir, name), `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600 });
  return id;
}

export async function drainInbox(runsDir: string): Promise<unknown[]> {
  const dir = inboxDir(runsDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  names.sort();
  const out: unknown[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      out.push(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch {
      /* skip corrupt */
    }
    await rm(path, { force: true });
  }
  return out;
}
