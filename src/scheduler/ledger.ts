import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QueueState } from "./queue.js";

export type LedgerEvent = {
  ts: string;
  key?: string;
  ref?: string;
  from?: QueueState;
  to?: QueueState;
  code?: string;
  costUsd?: number;
  wallSeconds?: number;
  kindDrift?: string;
  landedAs?: string;
  type: string;
};

const tails = new Map<string, Promise<void>>();

export function ledgerPath(runsDir: string): string {
  return join(runsDir, "_factory", "ledger.jsonl");
}

export async function appendLedger(runsDir: string, event: LedgerEvent): Promise<void> {
  const path = ledgerPath(runsDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(event)}\n`;
  const prev = tails.get(path) ?? Promise.resolve();
  const run = prev.then(() => appendFile(path, line, { encoding: "utf8", mode: 0o600 }));
  tails.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  await run;
}

export async function readLedger(runsDir: string, opts?: { since?: Date }): Promise<LedgerEvent[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath(runsDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const since = opts?.since?.getTime();
  const events: LedgerEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let event: LedgerEvent;
    try {
      event = JSON.parse(line) as LedgerEvent;
    } catch {
      continue;
    }
    if (since !== undefined) {
      const ts = Date.parse(event.ts);
      if (Number.isNaN(ts) || ts < since) continue;
    }
    events.push(event);
  }
  return events;
}
