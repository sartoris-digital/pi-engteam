import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Handoff } from "../git/handoff.js";
import type { LandedAs } from "../git/reconcile.js";
import type { LandedRecord } from "./types.js";

const tails = new Map<string, Promise<void>>();

export interface CodifyInboxRecord extends Handoff {
  kind: string;
  stages: string[];
  state: "published" | "landed";
  landedAs?: LandedAs;
  landedSha?: string;
  survival?: LandedRecord["survival"];
}

export function codifyInboxPath(runsDir: string): string {
  return join(runsDir, "_factory", "codify", "inbox.jsonl");
}

export async function appendCodifyInbox(runsDir: string, rec: CodifyInboxRecord): Promise<void> {
  const path = codifyInboxPath(runsDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(rec)}\n`;
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

export async function readCodifyInbox(runsDir: string): Promise<CodifyInboxRecord[]> {
  let text: string;
  try {
    text = await readFile(codifyInboxPath(runsDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: CodifyInboxRecord[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as CodifyInboxRecord);
    } catch {
      continue;
    }
  }
  return out;
}

export function landedFromInbox(row: CodifyInboxRecord): LandedRecord | undefined {
  if (row.landedAs === undefined || row.landedSha === undefined) return undefined;
  return {
    runId: row.runId,
    landedAs: row.landedAs,
    landedSha: row.landedSha,
    patchIds: row.patchIds,
    changedFiles: row.changedFiles,
    survival: row.survival ?? { reverted: false, retouched: false, linkedBug: false },
  };
}

export async function stampLanded(runsDir: string, rec: LandedRecord): Promise<void> {
  const rows = await readCodifyInbox(runsDir);
  let found = false;
  const next = rows.map((row) => {
    if (row.runId !== rec.runId) return row;
    found = true;
    return {
      ...row,
      state: "landed" as const,
      landedAs: rec.landedAs,
      landedSha: rec.landedSha,
      patchIds: rec.patchIds.length > 0 ? rec.patchIds : row.patchIds,
      changedFiles: rec.changedFiles.length > 0 ? rec.changedFiles : row.changedFiles,
      survival: rec.survival,
    };
  });
  if (!found) return;
  const path = codifyInboxPath(runsDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = next.map((row) => JSON.stringify(row)).join("\n") + (next.length > 0 ? "\n" : "");
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}
