// src/secrets/Watcher.ts
import { DEFAULT_PATTERNS, type SecretPattern } from "./patterns.js";

export type SecretMatch = {
  pattern: SecretPattern;
  value: string;
  start: number;
  end: number;
  preview: string;
};

export type EntropyConfig = {
  enabled: boolean;
  minLength: number;
  minBitsPerChar: number;
};

const DEFAULT_ENTROPY: EntropyConfig = {
  enabled: false,
  minLength: 32,
  minBitsPerChar: 4.5,
};

const ENTROPY_CHAR_CLASS = /[A-Za-z0-9_/+=-]+/g;

function makePreview(value: string): string {
  if (value.length < 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function patternsByPriority(patterns: SecretPattern[]): SecretPattern[] {
  return [...patterns].sort((a, b) => a.priority - b.priority);
}

export function scan(
  input: string,
  opts?: { patterns?: SecretPattern[]; entropy?: EntropyConfig },
): SecretMatch[] {
  const patterns = patternsByPriority(opts?.patterns ?? DEFAULT_PATTERNS);
  const entropy = opts?.entropy ?? DEFAULT_ENTROPY;

  const found: SecretMatch[] = [];
  const claimed: Array<[number, number]> = [];

  for (const pattern of patterns) {
    let flags = pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`;
    if (pattern.captureGroup !== undefined && !flags.includes("d")) flags = `${flags}d`;
    const re = new RegExp(pattern.regex.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      // guard against zero-length match infinite loop (defensive; loadUserPatterns should pre-reject)
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      let value: string;
      let start: number;
      let end: number;
      if (pattern.captureGroup !== undefined) {
        const groupIdx = m.indices?.[pattern.captureGroup];
        if (!groupIdx || m[pattern.captureGroup] === undefined) continue;
        [start, end] = groupIdx;
        value = m[pattern.captureGroup];
      } else {
        start = m.index;
        end = start + m[0].length;
        value = m[0];
      }
      if (overlaps(start, end, claimed)) continue;
      claimed.push([start, end]);
      found.push({
        pattern,
        value,
        start,
        end,
        preview: makePreview(value),
      });
    }
  }

  if (entropy.enabled) {
    for (const e of entropyFlag(input, entropy)) {
      if (overlaps(e.start, e.end, claimed)) continue;
      claimed.push([e.start, e.end]);
      found.push(e);
    }
  }

  found.sort((a, b) => a.start - b.start);
  return found;
}

function overlaps(start: number, end: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (start < e && end > s) return true;
  }
  return false;
}

export function rewriteWithPlaceholders(
  input: string,
  matches: SecretMatch[],
): { rewritten: string; placeholders: Array<{ name: string; original: string }> } {
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  const placeholders: Array<{ name: string; original: string }> = [];
  let out = "";
  let cursor = 0;
  for (const m of ordered) {
    if (m.start < cursor) continue;
    out += input.slice(cursor, m.start);
    out += `\${SECRET:${m.pattern.suggestedName}}`;
    placeholders.push({ name: m.pattern.suggestedName, original: m.value });
    cursor = m.end;
  }
  out += input.slice(cursor);
  return { rewritten: out, placeholders };
}

const ENTROPY_PATTERN: SecretPattern = {
  name: "High-entropy candidate",
  regex: /(?:)/g,
  suggestedName: "UNNAMED_SECRET",
  priority: Number.MAX_SAFE_INTEGER,
};

export function entropyFlag(input: string, cfg: EntropyConfig): SecretMatch[] {
  if (!cfg.enabled) return [];
  const out: SecretMatch[] = [];
  const re = new RegExp(ENTROPY_CHAR_CLASS.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const value = m[0];
    if (value.length < cfg.minLength) continue;
    if (shannonEntropy(value) < cfg.minBitsPerChar) continue;
    const start = m.index;
    const end = start + value.length;
    out.push({
      pattern: ENTROPY_PATTERN,
      value,
      start,
      end,
      preview: makePreview(value),
    });
  }
  return out;
}
