// Phase B item 12 — stream-source classifier. Parses chunks coming
// off the pi-cli subprocess stdout/stderr into typed activity events
// (`thinking`, `tool_call_invoke`, `tool_call_result`,
// `assistant_text`, `error`).
//
// Pi's bare-cli protocol on stdout uses light Markdown-ish framing:
//   * italic blocks (lines starting with `*…*` or wrapped in
//     asterisks) for "thinking"
//   * fenced code blocks (```$ cmd``` / ```bash …```) for
//     tool-call invocations + results
//   * plain text for assistant responses
//   * stderr for errors / diagnostics
//
// The classifier is intentionally heuristic: when Phase 0a probe
// data confirms a different shape per provider, the StreamSource
// enum in `capability-schema.ts` already records the proven source
// per provider and the caller can switch the classifier off (or
// route to a smarter parser) per provider.
import type { ActivityKind, SourceClass } from "./RunActivityQueue.js";

export type ClassifiedEvent = {
  kind: ActivityKind;
  body: string;
  sourceClass: SourceClass;
};

const THINKING_PREFIXES = [
  "thinking:",
  "*thinking",
  "<thinking>",
];

const TOOL_CALL_HINTS = [
  "tool_call:",
  "calling tool",
  "[tool_call]",
  /^\s*\$\s+\S/, // shell-style command line
];

const RESULT_HINTS = [
  "tool_result:",
  "[tool_result]",
];

const ERROR_HINTS = [
  /^error:/i,
  /^fatal:/i,
  /^\[ERROR\]/,
];

/**
 * Classify a single chunk into a typed event.
 *
 * Stateless per chunk — multi-line fenced blocks classify by their
 * first line's hint, and the classifier returns the chunk as-is for
 * the caller to forward to the activity queue.
 */
export function classifyChunk(rawChunk: string, sourceClass: SourceClass): ClassifiedEvent {
  const trimmed = rawChunk.trim();
  if (!trimmed) return { kind: "assistant_text", body: rawChunk, sourceClass };

  // stderr defaults to error unless empty.
  if (sourceClass === "stderr") {
    return { kind: "error", body: rawChunk, sourceClass };
  }

  const lower = trimmed.toLowerCase();

  for (const prefix of THINKING_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { kind: "thinking", body: rawChunk, sourceClass };
    }
  }
  // Italicized one-liners often indicate "thinking" in the pi-cli
  // protocol (the screenshot shows italic gray for these blocks).
  if (/^[*_].+[*_]\s*$/.test(trimmed)) {
    return { kind: "thinking", body: rawChunk, sourceClass };
  }

  for (const hint of TOOL_CALL_HINTS) {
    if (typeof hint === "string" ? lower.startsWith(hint) : hint.test(rawChunk)) {
      return { kind: "tool_call_invoke", body: rawChunk, sourceClass };
    }
  }
  for (const hint of RESULT_HINTS) {
    if (lower.startsWith(hint)) {
      return { kind: "tool_call_result", body: rawChunk, sourceClass };
    }
  }
  for (const re of ERROR_HINTS) {
    if (re.test(rawChunk)) return { kind: "error", body: rawChunk, sourceClass };
  }

  return { kind: "assistant_text", body: rawChunk, sourceClass };
}
