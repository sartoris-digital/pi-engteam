import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import type { EngteamEvent } from "../types.js";

const KEEP_TYPES = new Set([
  "request",
  "dispatch",
  "position",
  "adversarial",
  "synthesis",
  "correction",
  "verdict",
  "note",
]);

export type ConversationEntry = {
  ts: string;
  step?: string;
  agent?: string;
  kind: string;
  summary?: string;
  payload: Record<string, unknown>;
};

function eventToEntry(evt: EngteamEvent): ConversationEntry | undefined {
  let kind: string | undefined;
  if (KEEP_TYPES.has(evt.type)) kind = evt.type;
  else if (evt.category === "verdict" && evt.type === "emit") kind = "verdict";
  else if (evt.category === "message" && evt.type === "sent") kind = "dispatch";
  if (!kind) return undefined;
  return {
    ts: evt.ts,
    step: evt.step,
    agent: evt.agentName,
    kind,
    summary: evt.summary,
    payload: evt.payload,
  };
}

export function projectionPath(runDir: string): string {
  return join(runDir, "conversation.jsonl");
}

export async function appendProjection(
  runDir: string,
  evt: EngteamEvent,
): Promise<void> {
  const entry = eventToEntry(evt);
  if (!entry) return;
  await mkdir(runDir, { recursive: true });
  await appendFile(projectionPath(runDir), JSON.stringify(entry) + "\n", "utf8");
}

export async function readRecentEntries(
  runDir: string,
  n: number,
): Promise<ConversationEntry[]> {
  let raw: string;
  try {
    raw = await readFile(projectionPath(runDir), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const slice = lines.slice(Math.max(0, lines.length - n));
  const out: ConversationEntry[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as ConversationEntry);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function formatPrelude(entries: ConversationEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const who = e.agent ?? "system";
    const step = e.step ? ` @${e.step}` : "";
    const summary = e.summary ?? JSON.stringify(e.payload).slice(0, 200);
    return `- [${e.kind}${step}] ${who}: ${summary}`;
  });
  return ["## Recent conversation", ...lines, ""].join("\n");
}
