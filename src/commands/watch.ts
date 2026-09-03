import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { runDirPath } from "../engine/state.js";
import { findQueueEntry, readQueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runWatch(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<string> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("watch: missing ref");
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`watch: ${ref} not in queue`);
  if (entry.runId === undefined) throw new Error(`watch: ${ref} has no runId`);
  const lane = entry.lane ?? entry.kind ?? "lane";
  const path = join(runDirPath(deps.runsDir, entry.runId), "lanes", `${lane}.stream.jsonl`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, "", { encoding: "utf8", flag: "a", mode: 0o600 });
  return path;
}
