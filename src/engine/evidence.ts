import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { signRecord, verifyRecord } from "../safety/evidence-sign.js";
import { readGeneratedFile, readGeneratedJson, writeGeneratedFile, writeGeneratedJson } from "./state.js";
import type { EvidenceRecord } from "./types.js";

export type { EvidenceRecord } from "./types.js";

const FILE_RE = /^stage-(.+)-r(\d+)\.json$/;

export function evidencePath(runDir: string, stage: string, round: number): string {
  return join(runDir, "evidence", `stage-${stage}-r${round}.json`);
}

function sigPath(jsonPath: string): string {
  return `${jsonPath.slice(0, -".json".length)}.sig`;
}

/** The exact object that is signed and written: a JSON round-trip drops undefined fields. */
export function toPlainRecord(record: EvidenceRecord): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

export async function writeEvidence(runDir: string, record: EvidenceRecord, secret: string): Promise<string> {
  const runId = basename(runDir);
  await mkdir(join(runDir, "evidence"), { recursive: true, mode: 0o700 });
  const path = evidencePath(runDir, record.stage, record.round);
  const plain = toPlainRecord(record);
  await writeGeneratedJson(path, runId, plain);
  await writeGeneratedFile(sigPath(path), runId, `${signRecord(plain, secret)}\n`);
  return path;
}

export async function listEvidence(runDir: string): Promise<{ stage: string; round: number; path: string }[]> {
  let names: string[];
  try {
    names = await readdir(join(runDir, "evidence"));
  } catch {
    return [];
  }
  const out: { stage: string; round: number; path: string }[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.push({ stage: m[1], round: Number(m[2]), path: join(runDir, "evidence", name) });
  }
  return out.sort((a, b) => (a.stage === b.stage ? a.round - b.round : a.stage < b.stage ? -1 : 1));
}

export async function readEvidence(runDir: string, stage: string, round?: number): Promise<EvidenceRecord | null> {
  if (round !== undefined) return readGeneratedJson<EvidenceRecord>(evidencePath(runDir, stage, round));
  const rounds = (await listEvidence(runDir)).filter((e) => e.stage === stage);
  const latest = rounds[rounds.length - 1];
  return latest ? readGeneratedJson<EvidenceRecord>(latest.path) : null;
}

export async function verifyEvidence(
  runDir: string,
  stage: string,
  round: number,
  secret: string,
): Promise<{ ok: boolean; record: EvidenceRecord | null; reason?: string }> {
  const path = evidencePath(runDir, stage, round);
  const record = await readGeneratedJson<EvidenceRecord>(path);
  if (!record) return { ok: false, record: null, reason: "missing record" };
  const sigText = await readGeneratedFile(sigPath(path));
  if (sigText === null) return { ok: false, record, reason: "missing signature" };
  const sig = sigText.trim();
  const ok = verifyRecord(toPlainRecord(record), sig, secret);
  return ok ? { ok: true, record } : { ok: false, record, reason: "signature mismatch" };
}
