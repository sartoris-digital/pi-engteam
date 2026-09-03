import type { StepResult } from "../engine/types.js";
import type { SlotResult } from "./types.js";

const HEADING = /^##\s+(.+?)\s*$/gm;
const DEFAULT_REQUIRED = ["Goal", "Approach"];

function synthesizerOf(slots: SlotResult[]): SlotResult | undefined {
  return slots.find((s) => s.name === "synthesizer") ?? slots[slots.length - 1];
}

function sections(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const matches = [...text.matchAll(HEADING)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const title = (match[1] ?? "").trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[i + 1]?.index ?? text.length;
    found.set(title, text.slice(start, end));
  }
  return found;
}

export function mergeFuse(slots: SlotResult[]): StepResult {
  const synth = synthesizerOf(slots);
  const text = synth?.text ?? "";
  const issues: string[] = [];
  if (text.includes("[CONFLICT]")) issues.push("unresolved [CONFLICT]");
  const parsed = sections(text);
  for (const required of DEFAULT_REQUIRED) {
    if (!parsed.has(required)) issues.push(`missing section ${required}`);
  }
  const citeNames = slots.filter((s) => s !== synth).map((s) => s.name);
  for (const [title, body] of parsed) {
    const cited = citeNames.some((name) => body.includes(`[${name}]`));
    if (!cited) issues.push(`section ${title} cites no slot`);
  }
  if (issues.length > 0) return { verdict: "FAIL", issues, artifacts: { fuse: text } };
  return { verdict: "PASS", artifacts: { fuse: text } };
}
