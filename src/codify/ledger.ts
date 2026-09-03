import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RegistryState, TransitionBy } from "./registry.js";

export interface CodifiedLedgerEvent {
  at: string;
  name: string;
  version: number;
  from?: RegistryState;
  to: RegistryState;
  by: TransitionBy;
  reason: string;
  event: string;
}

const tails = new Map<string, Promise<void>>();

export function codifiedLedgerPath(home: string): string {
  return join(home, "codified", "codified-ledger.jsonl");
}

export async function appendCodifiedLedger(home: string, ev: CodifiedLedgerEvent): Promise<void> {
  const path = codifiedLedgerPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(ev)}\n`;
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

export async function readCodifiedLedger(home: string): Promise<CodifiedLedgerEvent[]> {
  let text: string;
  try {
    text = await readFile(codifiedLedgerPath(home), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: CodifiedLedgerEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      events.push(JSON.parse(line) as CodifiedLedgerEvent);
    } catch {
      continue;
    }
  }
  return events;
}
