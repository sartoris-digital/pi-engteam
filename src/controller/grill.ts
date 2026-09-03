import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const HANDOFF_ACTIONS = ["enqueue", "file-ticket", "save", "another-round", "drop"] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

export type GrillAnswerClass = "firm" | "soft" | "deferred";

const DEFERRED = /\b(defer(?:red)?|tbd|open question)\b/i;
const SOFT = /\b(maybe|kind of|sort of|not sure|i think|probably|idk|i don't know|unsure)\b/i;

export function classifyGrillAnswer(answer: string): GrillAnswerClass {
  const text = answer.trim();
  if (text.length === 0) return "soft";
  if (DEFERRED.test(text) && !/\bmaybe\b/i.test(text)) return "deferred";
  if (SOFT.test(text) || text.length < 12) return "soft";
  return "firm";
}

export function isHandoffAction(value: string): value is HandoffAction {
  return (HANDOFF_ACTIONS as readonly string[]).includes(value);
}

export async function appendHandoffLedger(
  runsDir: string,
  event: { type: string; runId: string; action: HandoffAction; ts: string },
): Promise<void> {
  const path = join(runsDir, "_factory", "ledger.jsonl");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}
