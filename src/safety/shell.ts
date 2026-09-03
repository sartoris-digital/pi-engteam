export const SUBST_PLACEHOLDER = "$(…)";
export const GROUP_PLACEHOLDER = "(…)";

export interface Redirect {
  op: string;
  target: string;
}

export function isWriteRedirect(op: string): boolean {
  return /^(?:\d*)>{1,2}\|?$/.test(op) || op === "&>" || op === "&>>";
}

export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    const next = command[i + 1];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (inSingle || inDouble) { current += ch; continue; }
    if (ch === "(" || ch === "{") { depth++; current += ch; continue; }
    if (ch === ")" || ch === "}") { depth--; current += ch; continue; }
    if (depth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (ch === "|" && /(?:^|[^|>])>\s*$/.test(current)) { current += ch; continue; }
      if (ch === "|" || ch === ";") { segments.push(current.trim()); current = ""; continue; }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.filter(Boolean);
}

function replaceSubstitutions(segment: string): string {
  return segment
    .replace(/\$\([^)]*\)/g, SUBST_PLACEHOLDER)
    .replace(/`[^`]*`/g, SUBST_PLACEHOLDER)
    .replace(/(^|\s)\(([^)]*)\)(?=\s|$)/g, `$1${GROUP_PLACEHOLDER}`);
}

export function tokenize(segment: string): { words: string[]; redirects: Redirect[] } {
  const replaced = replaceSubstitutions(segment);
  const redirects: Redirect[] = [];
  const words: string[] = [];
  const tokenRe = /(?:(\d*)(>>|>\||>|&>>|&>)|(\S+))/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  const src = replaced.trim();
  while ((m = tokenRe.exec(src)) !== null) parts.push(m[0]);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const redir = part.match(/^(\d*)(>>|>\||>|&>>|&>)$/);
    if (redir) {
      const target = parts[i + 1];
      if (target !== undefined && !target.startsWith(">")) {
        redirects.push({ op: part, target });
        i++;
        continue;
      }
    }
    words.push(part);
  }
  return { words, redirects };
}

export function stripAssignments(words: string[]): string[] {
  let i = 0;
  while (i < words.length && /^\w+=/.test(words[i] as string)) i++;
  return words.slice(i);
}
