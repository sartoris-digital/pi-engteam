// Phase B items 11, 13, 16 — durable single-owner activity-event
// queue. Decouples subprocess stdout-drain from disk + UI consumers
// so a slow disk / hung SSE never back-pressures the model
// (round 4 MED #1).
//
// On-disk layout under `<runsDir>/_activity/<runId>/`:
//   agent-activity.jsonl  — append-only event log
//   _seq.json             — monotonic seq counter persisted on flush
//   .lock                 — single-owner flock
//
// Bounded in-memory ring with kind-aware drop semantics:
//   - "thinking" and "pipe-buffered" drop first
//   - "tool_call_invoke", "tool_call_result", "error", "verdict",
//     "stuck-warning" coalesce into "(N essential events dropped)"
//     instead of blocking; >3 coalesces in 60s auto-disables Phase B
//     for the rest of the run (latched).
//
// Gated on Phase A `noNewWrites` and the Phase B
// `PI_ENGINEERING_ACTIVITY_STREAM` flag.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "fs";
import { constants } from "fs";
import { dirname, resolve } from "path";
import { getActivityPaths, type ActivityPaths } from "./activity-paths.js";

export type ActivityKind =
  | "thinking"
  | "tool_call_invoke"
  | "tool_call_result"
  | "assistant_text"
  | "error"
  | "verdict"
  | "stuck-warning"
  | "heartbeat"
  | "pipe-buffered"
  | "essential-coalesced";

export type SourceClass =
  | "stdout"
  | "stderr"
  | "audit-pre-close"
  | "audit-post-close-only"
  | "pty"
  | "synthetic";

export type AgentActivityEvent = {
  runId: string;
  agentName: string;
  step: string;
  seq: number;
  sourceTs: string;
  kind: ActivityKind;
  body: string;
  sourceClass: SourceClass;
};

const ESSENTIAL_KINDS: ReadonlySet<ActivityKind> = new Set([
  "tool_call_invoke",
  "tool_call_result",
  "error",
  "verdict",
  "stuck-warning",
]);

const DROP_FIRST_KINDS: ReadonlySet<ActivityKind> = new Set([
  "thinking",
  "pipe-buffered",
]);

export type QueueOptions = {
  runsDir: string;
  runId: string;
  ringCapacity?: number; // max in-memory events before drop/coalesce
  maxBodyBytes?: number; // per-event body cap (post-redaction)
  legacyMirrorEnabled?: boolean;
  // Test hook so unit tests can drive the in-process callback
  // without spawning consumers.
  onEvent?: (ev: AgentActivityEvent) => void;
};

export class RunActivityQueue {
  private readonly opts: Required<Omit<QueueOptions, "onEvent">> & { onEvent?: (ev: AgentActivityEvent) => void };
  private readonly paths: ActivityPaths;
  private seq: number;
  private ring: AgentActivityEvent[] = [];
  private coalescedEssentialInWindow: number = 0;
  private coalesceWindowStart: number = Date.now();
  private autoDisabled: boolean = false;
  private lockFd: number | undefined;

  constructor(opts: QueueOptions) {
    this.opts = {
      ringCapacity: opts.ringCapacity ?? 4096,
      maxBodyBytes: opts.maxBodyBytes ?? 32 * 1024,
      legacyMirrorEnabled: opts.legacyMirrorEnabled ?? true,
      runsDir: opts.runsDir,
      runId: opts.runId,
      onEvent: opts.onEvent,
    };
    this.paths = getActivityPaths(opts.runsDir, opts.runId);
    mkdirSync(this.paths.dir, { recursive: true });
    if (this.opts.legacyMirrorEnabled) {
      mkdirSync(dirname(this.paths.legacyMirror), { recursive: true });
    }
    this.seq = this.loadSeq();
  }

  /** Acquire the per-run exclusive lock so a second controller can't double-write. */
  acquireLock(): void {
    if (this.lockFd !== undefined) return;
    const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL;
    try {
      this.lockFd = openSync(this.paths.lock, flags, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `RunActivityQueue: lock already held at ${this.paths.lock} (a second controller may be writing this run).`,
        );
      }
      throw err;
    }
  }

  /** Release the lock + persist final seq. Safe to call on shutdown. */
  release(): void {
    if (this.lockFd !== undefined) {
      try {
        closeSync(this.lockFd);
      } catch { /* best-effort */ }
      this.lockFd = undefined;
      try {
        const { unlinkSync } = require("fs") as typeof import("fs");
        unlinkSync(this.paths.lock);
      } catch { /* best-effort */ }
    }
    this.persistSeq();
  }

  /**
   * Enqueue an event. Truncates body to `maxBodyBytes`. Returns
   * { accepted, drops } so callers can spot pressure.
   */
  enqueue(partial: Omit<AgentActivityEvent, "seq" | "sourceTs"> & { sourceTs?: string }): { accepted: boolean; dropped?: ActivityKind } {
    if (this.autoDisabled) return { accepted: false, dropped: partial.kind };
    const body = this.truncateBody(partial.body);
    const ev: AgentActivityEvent = {
      runId: partial.runId,
      agentName: partial.agentName,
      step: partial.step,
      seq: this.nextSeq(),
      sourceTs: partial.sourceTs ?? new Date().toISOString(),
      kind: partial.kind,
      body,
      sourceClass: partial.sourceClass,
    };

    if (this.ring.length >= this.opts.ringCapacity) {
      if (DROP_FIRST_KINDS.has(ev.kind)) {
        // Drop this non-essential event; do NOT persist.
        return { accepted: false, dropped: ev.kind };
      }
      if (ESSENTIAL_KINDS.has(ev.kind)) {
        // Coalesce into a single summary event so we don't block.
        this.coalescedEssentialInWindow++;
        if (Date.now() - this.coalesceWindowStart > 60_000) {
          this.coalesceWindowStart = Date.now();
          this.coalescedEssentialInWindow = 1;
        }
        if (this.coalescedEssentialInWindow > 3) {
          // Round 4 MED #1: latched auto-disable after sustained
          // pressure on essential kinds.
          this.autoDisabled = true;
        }
        const summary: AgentActivityEvent = {
          ...ev,
          kind: "essential-coalesced",
          body: `(${this.coalescedEssentialInWindow} essential events coalesced in window)`,
        };
        this.persist(summary);
        this.opts.onEvent?.(summary);
        return { accepted: true, dropped: ev.kind };
      }
    }

    this.ring.push(ev);
    if (this.ring.length > this.opts.ringCapacity * 2) this.ring.shift();
    this.persist(ev);
    this.opts.onEvent?.(ev);
    return { accepted: true };
  }

  /** True when latched auto-disable has fired. */
  isAutoDisabled(): boolean {
    return this.autoDisabled;
  }

  /** Diagnostic — current ring depth. */
  ringDepth(): number {
    return this.ring.length;
  }

  private nextSeq(): number {
    const out = this.seq;
    this.seq += 1;
    return out;
  }

  private loadSeq(): number {
    try {
      const text = readFileSync(this.paths.seq, "utf8");
      const parsed = JSON.parse(text);
      if (typeof parsed?.seq === "number" && Number.isFinite(parsed.seq)) return parsed.seq;
    } catch { /* fresh queue */ }
    return 0;
  }

  private persistSeq(): void {
    try {
      const tmp = `${this.paths.seq}.tmp`;
      writeFileSync(tmp, JSON.stringify({ seq: this.seq, lastWrite: new Date().toISOString() }), { mode: 0o600 });
      const { renameSync } = require("fs") as typeof import("fs");
      renameSync(tmp, this.paths.seq);
    } catch { /* best-effort */ }
  }

  private persist(ev: AgentActivityEvent): void {
    const line = JSON.stringify(ev) + "\n";
    try {
      appendFileSync(this.paths.jsonl, line, { mode: 0o600 });
    } catch { /* best-effort */ }
    if (this.opts.legacyMirrorEnabled) {
      try {
        appendFileSync(this.paths.legacyMirror, line, { mode: 0o600 });
      } catch { /* best-effort */ }
    }
    // Persist seq on every Nth write so a crash doesn't lose more
    // than N events worth of ordering on resume.
    if (this.seq % 16 === 0) this.persistSeq();
  }

  private truncateBody(body: string): string {
    if (Buffer.byteLength(body, "utf8") <= this.opts.maxBodyBytes) return body;
    // Naively slice at byte length — UTF-8 safe enough for ASCII-
    // dominant model output; non-ASCII gets one mangled trailing
    // codepoint at worst.
    return body.slice(0, this.opts.maxBodyBytes) + `... [TRUNCATED:${body.length - this.opts.maxBodyBytes}b]`;
  }

  // Test helper — resolve canonical jsonl path.
  get jsonlPath(): string {
    return resolve(this.paths.jsonl);
  }
  get legacyMirrorPath(): string {
    return resolve(this.paths.legacyMirror);
  }
}
