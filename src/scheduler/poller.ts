import { DEFAULTS } from "../config/defaults.js";
import type { AnalystPort } from "../intake/analyze.js";
import type { Ticket, TrackerAdapter } from "../trackers/adapter.js";
import type { TrackerRegistry } from "../trackers/discovery.js";
import { GhError } from "../trackers/gh.js";
import { admit, type AdmissionWorld } from "./admission.js";
import { claimTicket } from "./claim.js";
import { applyIntake } from "./intake-claim.js";
import { drainInbox } from "./inbox.js";
import { acquireDaemonLease, type DaemonLease } from "./lease.js";
import { readQueue, writeQueue } from "./queue.js";
import { readWatermark, writeWatermark } from "./watermark.js";

export interface SchedulerDeps {
  runsDir: string;
  adapters: TrackerRegistry;
  pollIntervalSeconds: number;
  now?: () => Date;
  onTicket: (ticket: Ticket, trackerId: string) => Promise<void | { skipped?: boolean }>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  acquireLease?: typeof acquireDaemonLease;
  label?: string;
}

export class Scheduler {
  private lease: DaemonLease | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  async start(): Promise<void> {
    this.stopped = false;
    const acquire = this.deps.acquireLease ?? acquireDaemonLease;
    this.lease = await acquire(this.deps.runsDir);
    if (!this.lease.holder) return;
    await this.drainOnce({ unwindowed: true });
    const ms = Math.max(1, this.deps.pollIntervalSeconds) * 1000;
    const setI = this.deps.setIntervalFn ?? setInterval;
    this.timer = setI(() => {
      void this.intervalTick();
    }, ms) as ReturnType<typeof setInterval>;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
      this.timer = null;
    }
    await this.lease?.stop();
    this.lease = null;
  }

  async drainOnce(opts?: { unwindowed?: boolean }): Promise<{ claimed: number; skipped: number }> {
    await drainInbox(this.deps.runsDir).catch(() => []);
    let claimed = 0;
    let skipped = 0;
    const now = this.deps.now ?? (() => new Date());
    const label = this.deps.label ?? DEFAULTS.trackerEntry.label;
    for (const [id, adapter] of this.deps.adapters) {
      const tickets = await this.listWithBackoff(adapter, {
        label,
        state: "open",
        unwindowed: opts?.unwindowed === true,
        trackerId: id,
      });
      if (tickets === null) continue;
      for (const ticket of tickets) {
        const result = await this.deps.onTicket(ticket, id);
        if (result?.skipped === true) skipped += 1;
        else claimed += 1;
      }
      await writeWatermark(this.deps.runsDir, id, now().toISOString());
    }
    return { claimed, skipped };
  }

  private async intervalTick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.drainOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async listWithBackoff(
    adapter: TrackerAdapter,
    opts: { label: string; state: string; unwindowed: boolean; trackerId: string },
  ): Promise<Ticket[] | null> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const jitter = this.deps.jitter ?? (() => 0.7 + Math.random() * 0.6);
    let updatedSince: Date | undefined;
    if (!opts.unwindowed) {
      const mark = await readWatermark(this.deps.runsDir, opts.trackerId);
      if (typeof mark?.updatedSince === "string") {
        const at = Date.parse(mark.updatedSince);
        if (!Number.isNaN(at)) updatedSince = new Date(at - 5 * 60_000);
      }
    }
    const query = {
      label: opts.label,
      state: opts.state,
      ...(updatedSince === undefined ? {} : { updatedSince }),
    };
    for (let n = 0; n < 5; n++) {
      try {
        return await adapter.list(query);
      } catch (err) {
        if (!isRetryable(err)) throw err;
        if (n === 4) return null;
        await sleep(Math.round(2 ** (n + 1) * 1000 * jitter()));
      }
    }
    return null;
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof GhError)) return false;
  const text = `${err.stderr}\n${err.message}\n${String(err.code)}`;
  return /429|Retry-After/i.test(text);
}

export function makeOnTicket(opts: {
  runsDir: string;
  adapterFor: (trackerId: string) => TrackerAdapter | undefined;
  authorized?: (ticket: Ticket, trackerId: string) => Promise<boolean> | boolean;
  world?: () => AdmissionWorld;
  now?: () => Date;
  analyst?: AnalystPort;
}): SchedulerDeps["onTicket"] {
  const world = opts.world ?? (() => ({
    running: [],
    maxLanes: 3,
    maxLanesPerRepo: 2,
    ticketsToday: 0,
    maxTicketsPerDay: 20,
    spendToday: 0,
    dailyBudgetUsd: 150,
    exclusiveRunning: false,
    predictedPaths: [],
  }));
  return async (ticket, trackerId) => {
    const adapter = opts.adapterFor(trackerId);
    if (adapter === undefined) return { skipped: true };
    const queue = await readQueue(opts.runsDir);
    const authorized = opts.authorized === undefined ? true : await opts.authorized(ticket, trackerId);
    const claimed = await claimTicket({
      adapter,
      ticket,
      queue,
      authorized,
      runsDir: opts.runsDir,
      now: opts.now,
    });
    if (claimed.skipped !== undefined) {
      await writeQueue(opts.runsDir, queue);
      return { skipped: true };
    }
    const decision = admit(claimed.entry, world());
    if (!decision.ok) {
      claimed.entry.state = decision.reason === "overlap" ? "waiting_lane" : "blocked";
      claimed.entry.lastError = decision.reason;
      await writeQueue(opts.runsDir, queue);
      return { skipped: true };
    }
    await applyIntake({
      ticket,
      entry: claimed.entry,
      adapter,
      analyst: opts.analyst,
    });
    await writeQueue(opts.runsDir, queue);
    return {};
  };
}
