export const SUBST_PLACEHOLDER = "$(…)";
export const GROUP_PLACEHOLDER = "(…)";

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const REDIRECT_OPS = ["&>>", "&>", ">>|", ">|", ">>", ">&", "<<<", "<<", ">", "<"] as const;

export interface Redirect {
  op: string;
  target: string;
}

export function isWriteRedirect(op: string): boolean {
  return /^(?:\d*)>{1,2}\|?$/.test(op) || op === "&>" || op === "&>>";
}

export function unquote(word: string): string {
  if (word.length >= 2) {
    const start = word[0];
    const end = word[word.length - 1];
    if ((start === "'" && end === "'") || (start === '"' && end === '"')) return word.slice(1, -1);
  }
  return word;
}

export function unsupportedShellConstruct(command: string): string | null {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    const next = command[i + 1];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (inDouble) {
      if (ch === "$" && next === "(") return "command substitution";
      if (ch === "`") return "backticks";
      continue;
    }
    if (ch === "\n" || ch === "\r") return "unquoted newline";
    if (ch === "$" && next === "(") return "command substitution";
    if (ch === "`") return "backticks";
    if ((ch === "<" || ch === ">") && next === "(") return "process substitution";
    if (ch === "&") {
      if (next === "&" || next === ">") {
        i++;
        continue;
      }
      const prev = i > 0 ? (command[i - 1] as string) : "";
      if (prev === ">") continue;
      return "background execution";
    }
  }
  return null;
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

function redirectAt(src: string, i: number): { op: string; len: number } | null {
  if (src.startsWith("&>>", i) || src.startsWith("&>", i)) {
    const op = src.startsWith("&>>", i) ? "&>>" : "&>";
    return { op, len: op.length };
  }
  let j = i;
  while (j < src.length && src[j]! >= "0" && src[j]! <= "9") j++;
  for (const op of REDIRECT_OPS) {
    if (src.startsWith(op, j)) return { op: src.slice(i, j + op.length), len: j + op.length - i };
  }
  return null;
}

function readToken(src: string, start: number): { token: string; end: number } {
  let i = start;
  let inSingle = false;
  let inDouble = false;
  while (i < src.length) {
    const ch = src[i] as string;
    if (!inSingle && !inDouble) {
      if (/\s/.test(ch)) break;
      if (redirectAt(src, i) !== null) break;
      if (ch === "'") { inSingle = true; i++; continue; }
      if (ch === '"') { inDouble = true; i++; continue; }
      i++;
      continue;
    }
    if (inSingle) {
      i++;
      if (ch === "'") inSingle = false;
      continue;
    }
    i++;
    if (ch === '"' && src[i - 2] !== "\\") inDouble = false;
  }
  return { token: src.slice(start, i), end: i };
}

export function tokenize(segment: string): { words: string[]; redirects: Redirect[] } {
  const replaced = replaceSubstitutions(segment);
  const redirects: Redirect[] = [];
  const words: string[] = [];
  const src = replaced.trim();
  let i = 0;
  const skipWs = (): void => {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
  };
  skipWs();
  while (i < src.length) {
    skipWs();
    if (i >= src.length) break;
    const redir = redirectAt(src, i);
    if (redir !== null) {
      i += redir.len;
      skipWs();
      const target = readToken(src, i);
      i = target.end;
      redirects.push({ op: redir.op, target: unquote(target.token) });
      continue;
    }
    const word = readToken(src, i);
    i = word.end;
    if (word.token.length > 0) words.push(word.token);
  }
  return { words, redirects };
}

export function stripAssignments(words: string[]): string[] {
  let i = 0;
  while (i < words.length && /^\w+=/.test(unquote(words[i] as string))) i++;
  return words.slice(i);
}

export function nestedShellCommands(words: string[]): string[] {
  const verb = unquote(words[0] ?? "").toLowerCase();
  if (!SHELLS.has(verb)) return [];
  const nested: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const flag = unquote(words[i] as string);
    if (flag === "-c" || flag === "-lc" || /^-[a-zA-Z]*c$/.test(flag)) {
      const cmd = words[i + 1];
      if (cmd !== undefined) nested.push(unquote(cmd));
    }
  }
  return nested;
}

export function outputFlagTargets(cmd: string[], verb: string): string[] {
  const targets: string[] = [];
  for (let i = 1; i < cmd.length; i++) {
    const w = unquote(cmd[i] as string);
    const takeNext = (): void => {
      const t = cmd[i + 1];
      if (t !== undefined && !unquote(t).startsWith("-")) {
        targets.push(unquote(t));
        i++;
      }
    };
    if (verb === "sort" && (w === "-o" || w === "--output")) {
      takeNext();
      continue;
    }
    if (w === "--output" || w === "--outDir" || w === "--outFile") {
      takeNext();
      continue;
    }
    for (const prefix of ["--output=", "--outDir=", "--outFile="]) {
      if (w.startsWith(prefix)) targets.push(w.slice(prefix.length));
    }
  }
  return targets;
}

export function assignmentName(word: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(unquote(word));
  return match?.[1] ?? null;
}
