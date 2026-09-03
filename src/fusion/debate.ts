import type { StepResult } from "../engine/types.js";
import type { SlotResult } from "./types.js";

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function keyOf(sentence: string): string {
  return sentence.replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim().toLowerCase();
}

export function mergeDebate(slots: SlotResult[]): StepResult {
  const perSlot = slots.map((slot) => ({ name: slot.name, sentences: sentences(slot.text) }));
  const counts = new Map<string, { display: string; names: Set<string> }>();
  for (const slot of perSlot) {
    const seen = new Set<string>();
    for (const sentence of slot.sentences) {
      const key = keyOf(sentence);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { display: sentence, names: new Set() };
      entry.names.add(slot.name);
      counts.set(key, entry);
    }
  }
  const needed = slots.length;
  const agreement: string[] = [];
  const disagreement: string[] = [];
  for (const entry of counts.values()) {
    if (needed > 0 && entry.names.size === needed) agreement.push(entry.display);
    else {
      const who = [...entry.names].map((n) => `[${n}]`).join("");
      disagreement.push(`${who} ${entry.display}`);
    }
  }
  const lines = ["## Agreement", ...agreement.map((s) => `- ${s}`), "", "## Disagreement", ...disagreement.map((s) => `- ${s}`)];
  return { verdict: "PASS", artifacts: { debate: lines.join("\n") } };
}
