// Phase C item 18 — central streaming redaction pipeline. The
// SINGLE choke point for every body that's persisted, streamed,
// rendered, or fed back into a model prompt. Patterns are
// conservative (length-bounded shape matches + env-name suffixes)
// and the output preserves a `[REDACTED:<class>:<origLen>]` marker
// so operators can see WHAT was redacted without the secret leaking.
//
// Order convention (round 2 MED #5 + round 8 MED #1):
//   redact FIRST → truncate SECOND. The streaming variant keeps a
//   256-byte rolling boundary overlap so a secret straddling chunk
//   boundaries still matches.
//
// Output formatters:
//   - redactForJsonl()   — for the JSONL on disk (raw redacted text)
//   - redactForTerminal()— strips ANSI/OSC control sequences
//   - redactForSse()     — JSON-encodes (no raw HTML)
//   - redactForHtml()    — HTML-escapes
//   - redactForPrompt()  — same as JSONL but capped for retry-prompt
//     excerpts (the redactor never trusts the model with secrets).

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // GitHub PATs
  { name: "github-pat-classic", re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: "github-pat-fine", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  // Anthropic + OpenAI shapes — Anthropic FIRST so a sk-ant-...
  // key isn't truncated by the generic openai-sk match.
  { name: "anthropic-sk-ant", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai-sk", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  // AWS keys
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws-secret-key", re: /(?<![A-Za-z0-9])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g },
  // JWT-shaped
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Bearer / Authorization headers
  { name: "bearer-token", re: /\b(?:Bearer|Authorization:)\s+[A-Za-z0-9._-]{20,}\b/gi },
  // Common env-style assignments where the right side looks like a secret
  { name: "env-token-assign", re: /\b([A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|_PAT))\s*=\s*["']?([^\s"']{8,})["']?/g },
];

type Replacement = { from: number; to: number; with: string };

function findReplacements(text: string): Replacement[] {
  const reps: Replacement[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (name === "env-token-assign" && m[1] && m[2]) {
        // Preserve the env name; redact the value only.
        const valueStart = m.index + m[0].indexOf(m[2]);
        reps.push({ from: valueStart, to: valueStart + m[2].length, with: `[REDACTED:${name}:${m[2].length}]` });
      } else {
        reps.push({ from: m.index, to: m.index + m[0].length, with: `[REDACTED:${name}:${m[0].length}]` });
      }
    }
  }
  // Sort by `from` ascending. We'll de-overlap below.
  reps.sort((a, b) => a.from - b.from || b.to - a.to);
  // Drop replacements that overlap an earlier longer match.
  const dedup: Replacement[] = [];
  let lastTo = -1;
  for (const r of reps) {
    if (r.from < lastTo) continue;
    dedup.push(r);
    lastTo = r.to;
  }
  return dedup;
}

/**
 * Redact a single string. Stateless (no boundary handling). Use
 * `StreamingRedactor` for chunked input.
 */
export function redact(text: string): string {
  if (!text) return text;
  const reps = findReplacements(text);
  if (reps.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const r of reps) {
    out += text.slice(cursor, r.from);
    out += r.with;
    cursor = r.to;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Streaming variant. Holds a small tail buffer between chunks so
 * boundary-straddling secrets still match. `flush()` releases the
 * remaining tail (which is itself redacted).
 */
export class StreamingRedactor {
  private tail = "";
  // 256-byte rolling overlap per PLAN item 18.
  private static readonly OVERLAP_BYTES = 256;

  push(chunk: string): string {
    const buf = this.tail + chunk;
    // Redact everything except the last OVERLAP_BYTES so the next
    // chunk's prefix can still match a straddling pattern.
    const cutoff = Math.max(0, buf.length - StreamingRedactor.OVERLAP_BYTES);
    const head = buf.slice(0, cutoff);
    const newTail = buf.slice(cutoff);
    const redactedHead = redact(head);
    this.tail = newTail;
    return redactedHead;
  }

  flush(): string {
    const out = redact(this.tail);
    this.tail = "";
    return out;
  }
}

// ----- Output formatters -----

const ANSI_OR_OSC = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

/** Redact + strip terminal control sequences for CLI/TUI display. */
export function redactForTerminal(text: string): string {
  return redact(text).replace(ANSI_OR_OSC, "");
}

/** Redact + JSON-encode for SSE / dashboard transport. */
export function redactForSse(text: string): string {
  return JSON.stringify(redact(text));
}

/** Redact + HTML-escape for browser dashboard rendering. */
export function redactForHtml(text: string): string {
  return redact(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Redact and bound for retry-prompt excerpts. The maximum size is
 * 4 KB per PLAN item 6, so a runaway tool output can't be re-fed
 * into the model verbatim.
 */
export function redactForPrompt(text: string, maxBytes = 4 * 1024): string {
  const redacted = redact(text);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  // Naive byte slice; non-ASCII may lose one trailing codepoint.
  return redacted.slice(0, maxBytes) + `... [TRUNCATED:prompt-excerpt:${redacted.length - maxBytes}b]`;
}
