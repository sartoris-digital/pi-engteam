import type { RateLimitConfig, ProviderQuota } from "./config.js";

export type RateLimitEvent =
  | { kind: "warn"; provider: string; account?: string; saturationPct: number }
  | { kind: "pause"; provider: string; account?: string; saturationPct: number };

type AcquireOk = { ok: true; ticketId: string };
type AcquireFail = { ok: false; reason: "concurrent" | "rpm" | "tpm" | "disabled-but-not-configured"; retryAfterMs: number };

type WindowEntry = { ts: number; tokens: number };

type ProviderState = {
  quota: ProviderQuota;
  window: WindowEntry[];
  inflight: number;
  prevSaturationPct: number;
};

type Ticket = {
  key: string;
  estimatedTokens: number;
  released: boolean;
};

function providerKey(provider: string, account?: string): string {
  return account ? `${provider}:${account}` : provider;
}

function prune(window: WindowEntry[], now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  while (window.length > 0 && window[0].ts < cutoff) {
    window.shift();
  }
}

function rpmUsage(window: WindowEntry[]): number {
  return window.length;
}

function tpmUsage(window: WindowEntry[]): number {
  let sum = 0;
  for (const e of window) sum += e.tokens;
  return sum;
}

function saturationPct(state: ProviderState, now: number): number {
  prune(state.window, now, state.quota.windowMs);
  const rpm = rpmUsage(state.window);
  const tpm = tpmUsage(state.window);
  const rpmPct = state.quota.rpmCeiling > 0 ? (rpm / state.quota.rpmCeiling) * 100 : 0;
  const tpmPct = state.quota.tpmCeiling > 0 ? (tpm / state.quota.tpmCeiling) * 100 : 0;
  return Math.max(rpmPct, tpmPct);
}

export class RateLimitGuard {
  private config: RateLimitConfig;
  private states: Map<string, ProviderState> = new Map();
  private tickets: Map<string, Ticket> = new Map();
  private totalInflight = 0;
  private clock: () => number;
  private onEvent?: (event: RateLimitEvent) => void;

  constructor(config: RateLimitConfig, onEvent?: (event: RateLimitEvent) => void, clock?: () => number) {
    this.config = config;
    this.onEvent = onEvent;
    this.clock = clock ?? (() => Date.now());

    for (const quota of config.providers) {
      const key = providerKey(quota.provider, quota.account);
      this.states.set(key, {
        quota,
        window: [],
        inflight: 0,
        prevSaturationPct: 0,
      });
    }
  }

  acquire(
    provider: string,
    opts?: { account?: string; estimatedTokens?: number },
  ): AcquireOk | AcquireFail {
    const ticketId = `${provider}-${this.clock()}-${Math.random().toString(36).slice(2)}`;
    const estimatedTokens = opts?.estimatedTokens ?? 0;

    if (!this.config.enabled) {
      this.tickets.set(ticketId, { key: "", estimatedTokens, released: false });
      return { ok: true, ticketId };
    }

    const key = providerKey(provider, opts?.account);
    const state = this.states.get(key);

    if (!state) {
      // Provider not configured — pass through
      this.tickets.set(ticketId, { key: "", estimatedTokens, released: false });
      return { ok: true, ticketId };
    }

    const now = this.clock();
    prune(state.window, now, state.quota.windowMs);

    // Concurrent check
    if (this.totalInflight >= this.config.maxConcurrent) {
      return { ok: false, reason: "concurrent", retryAfterMs: 1000 };
    }

    // RPM check
    if (rpmUsage(state.window) >= state.quota.rpmCeiling) {
      const oldest = state.window[0];
      const retryAfterMs = oldest ? oldest.ts + state.quota.windowMs - now : state.quota.windowMs;
      return { ok: false, reason: "rpm", retryAfterMs: Math.max(1, retryAfterMs) };
    }

    // TPM check
    const currentTpm = tpmUsage(state.window);
    if (estimatedTokens > 0 && currentTpm + estimatedTokens > state.quota.tpmCeiling) {
      const oldest = state.window[0];
      const retryAfterMs = oldest ? oldest.ts + state.quota.windowMs - now : state.quota.windowMs;
      return { ok: false, reason: "tpm", retryAfterMs: Math.max(1, retryAfterMs) };
    }

    // Claim slot
    state.window.push({ ts: now, tokens: estimatedTokens });
    state.inflight++;
    this.totalInflight++;

    this.tickets.set(ticketId, { key, estimatedTokens, released: false });

    this.emitThresholdEvents(state, provider, opts?.account, now);

    return { ok: true, ticketId };
  }

  release(ticketId: string, opts?: { actualTokens?: number; failed?: boolean }): void {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.released) return;

    ticket.released = true;

    if (!ticket.key) {
      // Pass-through ticket (disabled or unconfigured provider)
      return;
    }

    const state = this.states.get(ticket.key);
    if (!state) return;

    state.inflight = Math.max(0, state.inflight - 1);
    this.totalInflight = Math.max(0, this.totalInflight - 1);

    // Patch actual token count if provided
    if (opts?.actualTokens !== undefined && opts.actualTokens !== ticket.estimatedTokens) {
      // Find the entry we added and update it
      for (let i = state.window.length - 1; i >= 0; i--) {
        if (state.window[i].tokens === ticket.estimatedTokens) {
          state.window[i] = { ts: state.window[i].ts, tokens: opts.actualTokens };
          break;
        }
      }
    }
  }

  status(): Array<{
    provider: string;
    account?: string;
    inflight: number;
    rpmUsage: number;
    tpmUsage: number;
    rpmCeiling: number;
    tpmCeiling: number;
    saturationPct: number;
  }> {
    const now = this.clock();
    return Array.from(this.states.values()).map((state) => {
      prune(state.window, now, state.quota.windowMs);
      const rpm = rpmUsage(state.window);
      const tpm = tpmUsage(state.window);
      const rpmPct = state.quota.rpmCeiling > 0 ? (rpm / state.quota.rpmCeiling) * 100 : 0;
      const tpmPct = state.quota.tpmCeiling > 0 ? (tpm / state.quota.tpmCeiling) * 100 : 0;
      return {
        provider: state.quota.provider,
        account: state.quota.account,
        inflight: state.inflight,
        rpmUsage: rpm,
        tpmUsage: tpm,
        rpmCeiling: state.quota.rpmCeiling,
        tpmCeiling: state.quota.tpmCeiling,
        saturationPct: Math.max(rpmPct, tpmPct),
      };
    });
  }

  reset(): void {
    for (const state of this.states.values()) {
      state.window.length = 0;
      state.inflight = 0;
      state.prevSaturationPct = 0;
    }
    this.tickets.clear();
    this.totalInflight = 0;
  }

  private emitThresholdEvents(
    state: ProviderState,
    provider: string,
    account: string | undefined,
    now: number,
  ): void {
    if (!this.onEvent) return;
    const pct = saturationPct(state, now);
    const prev = state.prevSaturationPct;

    if (pct >= this.config.pauseThresholdPct && prev < this.config.pauseThresholdPct) {
      this.onEvent({ kind: "pause", provider, account, saturationPct: pct });
    } else if (pct >= this.config.warnThresholdPct && prev < this.config.warnThresholdPct) {
      this.onEvent({ kind: "warn", provider, account, saturationPct: pct });
    }

    state.prevSaturationPct = pct;
  }
}
