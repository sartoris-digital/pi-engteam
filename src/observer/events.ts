import { appendFile, mkdir, readdir, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export const EVENT_CATEGORIES = [
  "lifecycle",
  "tool_call",
  "tool_result",
  "message",
  "verdict",
  "budget",
  "safety",
  "approval",
  "error",
  "stage",
  "worker",
  "git",
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export function isEventCategory(x: unknown): x is EventCategory {
  return typeof x === "string" && (EVENT_CATEGORIES as readonly string[]).includes(x);
}

/** Canonical event `type` names. Stage name is `event.step`; host publish emits `run.published`. */
export const FACTORY_EVENTS = [
  "run.start",
  "run.end",
  "run.escalate",
  "run.pause",
  "run.resume",
  "stage.start",
  "stage.end",
  "run.published",
] as const;

export type FactoryEventName = (typeof FACTORY_EVENTS)[number];

/** One line of `<runDir>/events.jsonl`. `type` is dotted (`factory.stage.exit`, `factory.safety.block`, …). */
export interface FactoryEvent {
  ts: string;
  runId: string;
  category: EventCategory;
  type: string;
  step?: string;
  agent?: string;
  data?: Record<string, unknown>;
}

/** What callers pass to `emit`: ts and runId are stamped when absent. */
export type FactoryEventInput = Omit<FactoryEvent, "ts" | "runId"> & Partial<Pick<FactoryEvent, "ts" | "runId">>;

export const EVENTS_FILE = "events.jsonl";
export const DEFAULT_ROTATION_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_ROTATED = 10;
export const DEFAULT_MAX_DATA_BYTES = 2048;

const ROTATED_RE = /^events\.(\d+)\.jsonl$/;
const LOCK_NAME = ".events.lock";

/** Per canonical events path: serialize append/rotation across Observer instances. */
const appendTails = new Map<string, Promise<void>>();

export interface ObserverOptions {
  rotationBytes?: number;
  maxRotated?: number;
  maxDataBytes?: number;
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let n = Math.max(0, maxBytes);
  while (n > 0 && n < buf.byteLength && (buf[n]! & 0xc0) === 0x80) n--;
  return buf.subarray(0, n).toString("utf8");
}

/**
 * Spec §9.3: tool args and results are recorded clipped to 2 KB.
 * The cap is the UTF-8 byte length of `preview`, truncated on a code-point
 * boundary. The `{clipped, bytes, preview}` wrapper may itself exceed `maxBytes`.
 */
export function clipData(data: unknown, maxBytes: number = DEFAULT_MAX_DATA_BYTES): unknown {
  const json = JSON.stringify(data);
  if (json === undefined) return data;
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return data;
  return { clipped: true, bytes, preview: truncateUtf8Bytes(json, maxBytes) };
}

async function withDirLock(lockDir: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() - started > 5_000) throw new Error("observer: events write lock timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  try {
    await fn();
  } finally {
    await rmdir(lockDir).catch(() => undefined);
  }
}

/**
 * Host-owned JSONL audit log for one run directory.
 *
 * v0 contract: construct at most one Observer per canonical runDir (the
 * lane-runner holds `Map<runId, Observer>`). Same-process duplicates share a
 * write queue and a mkdir lock so rotation cannot drop events.
 */
export class Observer {
  readonly runDir: string;
  readonly runId: string;
  readonly path: string;
  private readonly rotationBytes: number;
  private readonly maxRotated: number;
  private readonly maxDataBytes: number;
  private queue: Promise<void> = Promise.resolve();
  private lastError: Error | null = null;

  constructor(runDir: string, runId: string, opts: ObserverOptions = {}) {
    this.runDir = resolve(runDir);
    this.runId = runId;
    this.path = join(this.runDir, EVENTS_FILE);
    this.rotationBytes = opts.rotationBytes ?? DEFAULT_ROTATION_BYTES;
    this.maxRotated = opts.maxRotated ?? DEFAULT_MAX_ROTATED;
    this.maxDataBytes = opts.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  }

  /** Validate synchronously, then append through a path-scoped serial queue (fire-and-forget). */
  emit(event: FactoryEventInput): void {
    if (!isEventCategory(event.category)) {
      throw new TypeError(`observer: unknown event category ${JSON.stringify(event.category)}`);
    }
    if (typeof event.type !== "string" || event.type === "") {
      throw new TypeError("observer: event.type must be a non-empty string");
    }
    const runId = event.runId ?? this.runId;
    if (typeof runId !== "string" || runId === "") {
      throw new TypeError("observer: event.runId must be a non-empty string");
    }
    const full: FactoryEvent = {
      ts: event.ts ?? new Date().toISOString(),
      runId,
      category: event.category,
      type: event.type,
    };
    if (event.step !== undefined) full.step = event.step;
    if (event.agent !== undefined) full.agent = event.agent;
    if (event.data !== undefined) full.data = clipData(event.data, this.maxDataBytes) as Record<string, unknown>;
    const line = JSON.stringify(full) + "\n";
    const prev = appendTails.get(this.path) ?? Promise.resolve();
    const run = prev.then(() => this.append(line));
    appendTails.set(this.path, run.then(() => undefined, () => undefined));
    this.queue = run.catch((err: unknown) => {
      this.lastError = err instanceof Error ? err : new Error(String(err));
    });
  }

  /** Wait for every queued append on this run's events path; rethrow the most recent write failure once. */
  async flush(): Promise<void> {
    await (appendTails.get(this.path) ?? this.queue);
    if (this.lastError !== null) {
      const err = this.lastError;
      this.lastError = null;
      throw err;
    }
  }

  private async append(line: string): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await withDirLock(join(this.runDir, LOCK_NAME), async () => {
      await this.rotateIfNeeded();
      const exists = await stat(this.path).then(() => true, () => false);
      if (!exists) {
        const open: FactoryEvent = {
          ts: new Date().toISOString(),
          runId: this.runId,
          category: "lifecycle",
          type: "observer.open",
          data: { generated: true },
        };
        await appendFile(this.path, JSON.stringify(open) + "\n", { encoding: "utf8", mode: 0o600 });
      }
      await appendFile(this.path, line, "utf8");
    });
  }

  private async rotateIfNeeded(): Promise<void> {
    const size = await stat(this.path).then((s) => s.size, () => -1);
    if (size < 0 || size < this.rotationBytes) return;
    const rotated = (await readdir(this.runDir))
      .map((name) => ROTATED_RE.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => b - a);
    for (const n of rotated) {
      const from = join(this.runDir, `events.${n}.jsonl`);
      if (n + 1 > this.maxRotated) {
        await unlink(from);
        continue;
      }
      await rename(from, join(this.runDir, `events.${n + 1}.jsonl`));
    }
    await rename(this.path, join(this.runDir, "events.1.jsonl"));
  }
}

/** Parse one events file. Missing file → []. Every other filesystem error propagates. */
export async function readEvents(runDir: string, file: string = EVENTS_FILE): Promise<FactoryEvent[]> {
  let text: string;
  try {
    text = await readFile(join(runDir, file), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: FactoryEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    events.push(JSON.parse(line) as FactoryEvent);
  }
  return events;
}
