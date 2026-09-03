import type { StepResult } from "../engine/types.js";
import { fenceData } from "../safety/fence.js";
import { isDroppedSlot } from "./degrade.js";
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

/** Whitespace/case-insensitive form used to decide whether a position moved between rounds. */
export function normalizePosition(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when at least one surviving slot said something different from the previous round.
 * A debate that produces no movement is stopped early instead of burning another round.
 */
export function positionsChanged(previous: SlotResult[], next: SlotResult[]): boolean {
  for (const slot of next) {
    const before = previous.find((p) => p.name === slot.name);
    if (before === undefined) return true;
    if (normalizePosition(before.text) !== normalizePosition(slot.text)) return true;
  }
  return false;
}

/**
 * The labelled prior-round opinions of every OTHER slot, ready to drop into a debate prompt.
 *
 * Every opinion is model output, so it is fenced with the run nonce exactly as slot text is
 * elsewhere: the model sees quoted data, never instructions. Slots that failed are labelled
 * as unavailable and carry no text at all (their error string is host output, not debate
 * material, so it is never interpolated either).
 */
export function debatePacket(self: string, prior: SlotResult[], nonce: string): string {
  const others = prior.filter((slot) => slot.name !== self);
  if (others.length === 0) return "";
  return others
    .map((slot) => {
      if (isDroppedSlot(slot) || slot.text.length === 0) {
        return `## [${slot.name}] ${slot.model} — PARTICIPANT UNAVAILABLE\n(no opinion available this round)`;
      }
      const fenced = slot.fenced ?? fenceData(slot.text, nonce, `FUSION-${slot.name}`);
      return `## [${slot.name}] ${slot.model} — CONCRETE OPINION\n${fenced}`;
    })
    .join("\n\n");
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

/** Round-by-round transcript so the evidence shows how positions moved, not just where they landed. */
export function debateRoundsArtifact(rounds: SlotResult[][]): string {
  const out: string[] = [];
  rounds.forEach((slots, index) => {
    out.push(`## Round ${index + 1}`);
    for (const slot of slots) {
      if (isDroppedSlot(slot)) {
        out.push(`### [${slot.name}] ${slot.model} — UNAVAILABLE`);
        continue;
      }
      out.push(`### [${slot.name}] ${slot.model}`);
      out.push(slot.text);
    }
    out.push("");
  });
  return out.join("\n").trimEnd();
}

/** Attach the round progression to an already-merged debate result without changing its verdict. */
export function withDebateRounds(result: StepResult, rounds: SlotResult[][]): StepResult {
  if (rounds.length < 2) return result;
  return {
    ...result,
    artifacts: { ...result.artifacts, debateRounds: debateRoundsArtifact(rounds) },
  };
}

/**
 * Round-aware entry point: merge the FINAL round's surviving positions and keep the
 * progression alongside it. `mergeDebate` stays the single-round merge other callers use.
 */
export function mergeDebateRounds(rounds: SlotResult[][]): StepResult {
  const final = rounds[rounds.length - 1] ?? [];
  return withDebateRounds(mergeDebate(final.filter((s) => !isDroppedSlot(s))), rounds);
}
