import { readFile, stat } from "node:fs/promises";
import { Value } from "typebox/value";
import { VerdictPayloadSchema, VERDICT_MAX_BYTES, type VerdictPayload } from "./types.js";

export type ParseVerdictResult =
  | { ok: true; payload: VerdictPayload }
  | { ok: false; error: string; fatal: boolean };

export function parseVerdict(text: string, maxBytes: number = VERDICT_MAX_BYTES): ParseVerdictResult {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    return { ok: false, fatal: true, error: `verdict exceeds ${maxBytes} bytes (${bytes})` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, fatal: false, error: `verdict is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, fatal: true, error: "verdict must be a JSON object" };
  }
  const cleaned = Value.Clean(VerdictPayloadSchema, raw);
  if (!Value.Check(VerdictPayloadSchema, cleaned)) {
    const errors = Value.Errors(VerdictPayloadSchema, cleaned).map((e) => `${e.instancePath || "/"}: ${e.message}`);
    return { ok: false, fatal: true, error: `verdict failed schema validation: ${errors.join("; ")}` };
  }
  return { ok: true, payload: cleaned };
}

export async function readVerdictFileOnce(
  path: string,
  maxBytes: number = VERDICT_MAX_BYTES,
): Promise<ParseVerdictResult | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (size > maxBytes) {
    return { ok: false, fatal: true, error: `verdict file exceeds ${maxBytes} bytes (${size})` };
  }
  return parseVerdict(await readFile(path, "utf8"), maxBytes);
}

export interface WaitForVerdictOptions {
  signal: AbortSignal;
  pollMs?: number;
  maxBytes?: number;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls until a valid verdict parses; null on abort or when the file can never become valid. */
export async function waitForVerdictFile(path: string, opts: WaitForVerdictOptions): Promise<VerdictPayload | null> {
  const pollMs = opts.pollMs ?? 250;
  const maxBytes = opts.maxBytes ?? VERDICT_MAX_BYTES;
  while (!opts.signal.aborted) {
    const result = await readVerdictFileOnce(path, maxBytes);
    if (result !== null) {
      if (result.ok) return result.payload;
      if (result.fatal) return null;
    }
    await sleepUnlessAborted(pollMs, opts.signal);
  }
  return null;
}
