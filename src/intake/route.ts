import type { Brief } from "./brief-schema.js";

export type IntakeRoute =
  | { action: "proceed"; brief: Brief }
  | { action: "needs-triage" | "needs-info"; brief: Brief; comment: string };

export interface AbstentionInput {
  brief: Brief;
  reason: "needs-triage" | "needs-info";
  missing: string[];
}

function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return text.slice(0, end);
}

/** Local quote sanitiser until callers switch to git/prbody neutralizeQuoted (Group 4). */
function quoteUntrusted(text: string, maxBytes = 8192): string {
  const capped = capBytes(text.replace(/\r\n?/g, "\n"), maxBytes);
  return capped
    .split("\n")
    .map((line) => line.replace(/^([ \t]*)([/@!][^\s]*)/, (_m, ws: string, tok: string) => `${ws}\`${tok}\``))
    .join("\n");
}

function blockquote(text: string): string {
  const n = quoteUntrusted(text);
  if (n === "") return ">";
  return n
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function allInferred(brief: Brief): boolean {
  if (brief.kind === "chore") return false;
  if (brief.acceptanceCriteria.length === 0) return true;
  return brief.acceptanceCriteria.every((ac) => ac.source === "inferred");
}

function withTier(brief: Brief, elevate: boolean): Brief {
  if (!elevate && brief.tier === "elevated") return brief;
  if (!elevate) return brief;
  return brief.tier === "elevated" ? brief : { ...brief, tier: "elevated" };
}

function shouldElevate(brief: Brief): boolean {
  if (brief.flags.includes("injectionSuspect")) return true;
  if (brief.kind === "feature" && brief.confidence === "MEDIUM") return true;
  return false;
}

/** Host-owned abstention comment (spec §3.9). Model/ticket text only inside quotes. */
export function formatAbstentionComment(input: AbstentionInput): string {
  const { brief, missing } = input;
  const why = brief.confidence === "LOW" ? "LOW confidence" : brief.confidence;
  const acLines =
    brief.acceptanceCriteria.length === 0
      ? "> _(none recorded)_"
      : brief.acceptanceCriteria
          .map((ac) => `${blockquote(`${ac.id}: ${ac.text}`)}`)
          .join("\n");
  const missingLine = missing.length > 0 ? missing.join("; ") : "see above";
  return [
    "Factory could not classify/ready this ticket.",
    `Proposed: \`${brief.kind}\` (\`${why}\`).`,
    "Proposed acceptance criteria:",
    acLines,
    `Missing: ${missingLine}.`,
    "Add `factory:kind=<x>` / `factory:ac-confirmed`, or edit and re-add `factory:ready`.",
  ].join("\n");
}

/** Spec §3.8 routing table. injectionSuspect raises tier; it never blocks. */
export function routeBrief(brief: Brief): IntakeRoute {
  const elevate = shouldElevate(brief);
  const next = withTier(brief, elevate || brief.tier === "elevated");

  if (allInferred(brief)) {
    const comment = formatAbstentionComment({
      brief: next,
      reason: "needs-info",
      missing: ["quoted or derived acceptance criteria"],
    });
    return { action: "needs-info", brief: next, comment };
  }

  if (brief.confidence === "LOW") {
    const comment = formatAbstentionComment({
      brief: next,
      reason: "needs-triage",
      missing: ["classification confidence"],
    });
    return { action: "needs-triage", brief: next, comment };
  }

  return { action: "proceed", brief: next };
}
