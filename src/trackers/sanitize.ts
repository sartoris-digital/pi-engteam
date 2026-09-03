import { isTicketKind, type TicketKind } from "./adapter.js";

export interface TrackerPrior {
  kind?: TicketKind;
  from: "label" | "issue-type" | "title-prefix" | "none";
  labels: string[];
}

const INVISIBLE_CP = new Set<number>([
  0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e,
  0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066,
  0x2067, 0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0x3164, 0xfeff, 0xffa0,
  0xfff9, 0xfffa, 0xfffb,
]);

const TITLE_PREFIX: Record<string, TicketKind> = {
  fix: "bug",
  bug: "bug",
  feat: "feature",
  feature: "feature",
  chore: "chore",
  enhancement: "enhancement",
};

function stripInvisible(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (INVISIBLE_CP.has(cp)) continue;
    if (cp >= 0xfe00 && cp <= 0xfe0f) continue;
    if (cp >= 0xe0000 && cp <= 0xe007f) continue;
    if (cp >= 0x180b && cp <= 0x180d) continue;
    out += ch;
  }
  return out;
}

function stripQuotedAttr(text: string, name: string): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*(["'])[\\s\\S]*?\\1`, "gi");
  return text.replace(re, "");
}

/** Strip HTML comments, invisible chars, image alt / hidden attrs; normalise whitespace. Never interprets fenced text. */
export function sanitizeTicketText(text: string): string {
  let s = text.replace(/\r\n?/g, "\n");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "![]($2)");
  s = stripQuotedAttr(s, "alt");
  s = s.replace(/\salt\s*=\s*[^\s>]+/gi, "");
  s = stripQuotedAttr(s, "aria-hidden");
  s = s.replace(/\sstyle\s*=\s*(["'])[^"']*display\s*:\s*none[^"']*\1/gi, "");
  s = s.replace(/\sstyle\s*=\s*(["'])[^"']*visibility\s*:\s*hidden[^"']*\1/gi, "");
  s = s.replace(/\s\bhidden\b(?=[\s>/])/gi, "");
  s = stripInvisible(s);
  s = s.replace(/[^\S\n]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const KIND_LABEL = /\bfactory:kind=([A-Za-z]+)\b/gi;
const TITLE_PREFIX_RE = /^(fix|feat|feature|bug|chore|enhancement)\s*:\s*/i;

/** Blind the analyst copy: drop kind labels and title prefixes; record the host-only prior. */
export function stripTrackerPrior(text: string): { blinded: string; prior: TrackerPrior } {
  const labels: string[] = [];
  let kind: TicketKind | undefined;
  let from: TrackerPrior["from"] = "none";

  let blinded = text.replace(KIND_LABEL, (_m, raw: string) => {
    const token = `factory:kind=${raw.toLowerCase()}`;
    labels.push(token);
    if (isTicketKind(raw.toLowerCase())) {
      kind = raw.toLowerCase() as TicketKind;
      from = "label";
    }
    return "";
  });

  blinded = blinded.replace(TITLE_PREFIX_RE, (_m, raw: string) => {
    const mapped = TITLE_PREFIX[raw.toLowerCase()];
    if (mapped !== undefined && from === "none") {
      kind = mapped;
      from = "title-prefix";
    }
    return "";
  });

  blinded = blinded.replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { blinded, prior: from === "none" ? { from, labels } : { kind, from, labels } };
}
