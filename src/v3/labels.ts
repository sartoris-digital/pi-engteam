import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KINDS, type Kind } from "../config/schema.js";
import { factoryHome, runsDir } from "../home.js";

export type LabelSource = "human" | "model";

export interface LabelRecord {
  ts: string;
  ref: string;
  kind: Kind;
  confirmedBy: string;
  source: LabelSource;
}

const tails = new Map<string, Promise<void>>();

const EMPTY_COUNTS: Record<Kind, number> = { feature: 0, enhancement: 0, bug: 0, chore: 0 };

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** `runs/_factory/labels.jsonl` under PI_SDLC_HOME / factoryHome(). */
export function labelsPath(home: string = factoryHome()): string {
  return join(runsDir(home), "_factory", "labels.jsonl");
}

function parseRecord(raw: unknown): LabelRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ts !== "string" || typeof rec.ref !== "string" || typeof rec.confirmedBy !== "string") return null;
  if (!isKind(rec.kind)) return null;
  if (rec.source !== "human" && rec.source !== "model") return null;
  return { ts: rec.ts, ref: rec.ref, kind: rec.kind, confirmedBy: rec.confirmedBy, source: rec.source };
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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

export async function appendLabel(
  record: Omit<LabelRecord, "ts"> & { ts?: string },
  home: string = factoryHome(),
): Promise<void> {
  const row: LabelRecord = {
    ts: record.ts ?? new Date().toISOString(),
    ref: record.ref,
    kind: record.kind,
    confirmedBy: record.confirmedBy,
    source: record.source,
  };
  await appendLine(labelsPath(home), `${JSON.stringify(row)}\n`);
}

export async function readLabels(home: string = factoryHome()): Promise<LabelRecord[]> {
  let text: string;
  try {
    text = await readFile(labelsPath(home), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LabelRecord[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = parseRecord(raw);
    if (rec !== null) out.push(rec);
  }
  return out;
}

/** Counts `source === "human"` only. Missing/invalid file → zeros. */
export async function countByKind(path: string = labelsPath()): Promise<Record<Kind, number>> {
  const counts: Record<Kind, number> = { ...EMPTY_COUNTS };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return counts;
    throw err;
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = parseRecord(raw);
    if (rec === null || rec.source !== "human") continue;
    counts[rec.kind] += 1;
  }
  return counts;
}
