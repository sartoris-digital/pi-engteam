import { appendFile, mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { generatedMarker } from "../home.js";

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

export interface ObserverOptions {
  rotationBytes?: number;
  maxRotated?: number;
  maxDataBytes?: number;
}

/** Spec §9.3: tool args and results are recorded clipped to 2 KB. */
export function clipData(data: unknown, maxBytes: number = DEFAULT_MAX_DATA_BYTES): unknown {
  const json = JSON.stringify(data);
  if (json === undefined) return data;
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return data;
  return { clipped: true, bytes, preview: json.slice(0, maxBytes) };
}

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
    this.runDir = runDir;
    this.runId = runId;
    this.path = join(runDir, EVENTS_FILE);
    this.rotationBytes = opts.rotationBytes ?? DEFAULT_ROTATION_BYTES;
    this.maxRotated = opts.maxRotated ?? DEFAULT_MAX_ROTATED;
    this.maxDataBytes = opts.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  }

  /** Validate synchronously, then append through a serial queue (fire-and-forget). */
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
    this.queue = this.queue
      .then(() => this.append(line))
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err : new Error(String(err));
      });
  }

  /** Wait for every queued append; rethrow the most recent write failure once. */
  async flush(): Promise<void> {
    await this.queue;
    if (this.lastError !== null) {
      const err = this.lastError;
      this.lastError = null;
      throw err;
    }
  }

  private async append(line: string): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await this.rotateIfNeeded();
    const exists = await stat(this.path).then(() => true, () => false);
    if (!exists) {
      await appendFile(this.path, generatedMarker(this.runId) + "\n", { encoding: "utf8", mode: 0o600 });
    }
    await appendFile(this.path, line, "utf8");
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

/** Parse one events file, skipping the marker line and blanks. Missing file → []. */
export async function readEvents(runDir: string, file: string = EVENTS_FILE): Promise<FactoryEvent[]> {
  const text = await readFile(join(runDir, file), "utf8").catch(() => "");
  const events: FactoryEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("<!--")) continue;
    events.push(JSON.parse(line) as FactoryEvent);
  }
  return events;
}
