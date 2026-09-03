import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ScreenFlags {
  injectionSuspect: boolean;
  reasons: string[];
}

export interface UnauthorizedTrigger {
  tracker: string;
  ref: string;
  login: string;
  at?: string;
}

/** Append `{ type: "unauthorized-trigger", tracker, ref, login, at }` to runs/_factory/ledger.jsonl. */
export async function recordUnauthorized(runsDir: string, event: UnauthorizedTrigger): Promise<void> {
  const at = event.at ?? new Date().toISOString();
  const path = join(runsDir, "_factory", "ledger.jsonl");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({
    type: "unauthorized-trigger",
    tracker: event.tracker,
    ref: event.ref,
    login: event.login,
    at,
    ts: at,
  });
  await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
const SHELL_RE = /\b(curl|wget|nc|ncat|bash|zsh|cmd\.exe|powershell)\b|\brm\s+-rf\b|\$\(|`[^`]+`/i;
const IGNORE_RE = /\b(ignore|disregard|forget)\b[\s\S]{0,40}\b(previous|above|prior)\b|\bignore previous\b/i;
const CREDENTIAL_RE =
  /\b(api[_-]?key|secret[_-]?key|password|passwd|bearer|authorization)\b|\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}|\bgithub_pat_[A-Za-z0-9_]+\b|\bsk-[A-Za-z0-9]{8,}|\bAKIA[A-Z0-9]{8,}/i;
const TOOL_RE = /\b(VerdictEmit|RequestApproval|pi\.exec)\b/;

/** Flag injection-shaped ticket text. Never throws; never blocks — only sets injectionSuspect. */
export function screenText(text: string): ScreenFlags {
  try {
    const reasons: string[] = [];
    if (IGNORE_RE.test(text)) reasons.push("ignore-previous");
    if (URL_RE.test(text)) reasons.push("url");
    if (SHELL_RE.test(text)) reasons.push("shell");
    if (CREDENTIAL_RE.test(text)) reasons.push("credential");
    if (TOOL_RE.test(text)) reasons.push("tool-name");
    return { injectionSuspect: reasons.length > 0, reasons };
  } catch {
    return { injectionSuspect: false, reasons: [] };
  }
}
