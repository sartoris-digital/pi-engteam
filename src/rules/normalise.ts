const LEADING_FILLER = /^(please|kindly|kindly please)\s+/i;
const YOU_SHOULD = /^(you\s+should|we\s+should|one\s+should|always\s+remember\s+to)\s+/i;
const PRONOUNS = /\b(i|we|you|they|your|yours|our|ours|my|mine|their|theirs|me|us|them)\b/gi;

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] ?? trimmed).trim();
}

/** Imperative, one sentence, no pronouns. */
export function normaliseRuleText(text: string): string {
  let out = text.trim().replace(/\s+/g, " ");
  out = firstSentence(out);
  out = out.replace(LEADING_FILLER, "");
  out = out.replace(YOU_SHOULD, "");
  out = out.replace(PRONOUNS, " ").replace(/\s+/g, " ").trim();
  out = out.replace(/^[.,;:]+/, "").replace(/\s+/g, " ").trim();
  if (out.length === 0) return "";
  out = out.replace(/[.!?]+$/, "");
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return `${out}.`;
}
