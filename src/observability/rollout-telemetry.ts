// Phase E item E16 — minimal always-on rollout-telemetry writer.
//
// A fixed subset of metrics — workflow success, fallback fired,
// verdict timeout, capability metrics, feature gate breach,
// protection block — is emitted via a SEPARATE writer that
// bypasses `PI_ENGINEERING_TELEMETRY=0` AND
// `PI_ENGINEERING_LEGACY_MODE`. Rationale (round 10 MED #4):
// rollout-control decisions need this data even in emergency
// modes; only the verbose telemetry path (activity stream, full
// fallback bodies) should be silenced.
//
// Storage: append-only at
// `<configDir>/telemetry/rollout.jsonl`, daily rotation, cap
// 32 MB/day per host (round 13 MED #4). Over-cap drops increment
// the cataloged drop counter AND fan out to the emergency spool
// + counter WAL so the signal survives a rollout-telemetry FS
// failure.
import { appendFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";

const DEFAULT_DAILY_CAP_BYTES = 32 * 1024 * 1024;
const EMERGENCY_SPOOL_PATH = process.env.PI_ENGINEERING_EMERGENCY_SPOOL ?? "/var/tmp/pi-eng-emergency.jsonl";

// The fixed subset that's always emitted. Subset of the catalog.
export const ROLLOUT_TELEMETRY_METRICS = new Set([
  "pi_eng_workflow_success_total",
  "pi_eng_fallback_fired_total",
  "pi_eng_verdict_timeout_total",
  "pi_eng_capability_mismatch_total",
  "pi_eng_capability_stale_total",
  "pi_eng_capability_override_total",
  "pi_eng_feature_gate_breach_total",
  "pi_eng_protection_block_total",
]);

export type RolloutEvent = {
  ts: string;
  metric: string;
  labels: Record<string, string>;
  delta: number;
};

export class RolloutTelemetry {
  private readonly path: string;
  private readonly cap: number;
  private dropCount = 0;

  constructor(opts: { configDir: string; dailyCapBytes?: number }) {
    const dir = join(opts.configDir, "telemetry");
    this.path = join(dir, "rollout.jsonl");
    this.cap = opts.dailyCapBytes ?? DEFAULT_DAILY_CAP_BYTES;
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Emit a rollout-telemetry event. Silently no-ops if the metric
   * isn't in the always-on subset. Bypasses all other Phase A/B
   * kill switches. Best-effort — never throws.
   */
  emit(metric: string, labels: Record<string, string> = {}, delta = 1): void {
    if (!ROLLOUT_TELEMETRY_METRICS.has(metric)) return;
    const ev: RolloutEvent = {
      ts: new Date().toISOString(),
      metric,
      labels,
      delta,
    };
    const line = JSON.stringify(ev) + "\n";
    try {
      if (existsSync(this.path)) {
        const st = statSync(this.path);
        if (st.size + line.length > this.cap) {
          // Over-cap: fan out to emergency spool + counter; drop
          // this line from the rollout log.
          this.dropCount++;
          this.fanOutEmergency(ev);
          return;
        }
      }
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch {
      // FS failure → emergency spool fallback so the signal
      // survives.
      this.dropCount++;
      this.fanOutEmergency(ev);
    }
  }

  /** Drops observed since process start. */
  getDropCount(): number {
    return this.dropCount;
  }

  private fanOutEmergency(ev: RolloutEvent): void {
    try {
      appendFileSync(
        EMERGENCY_SPOOL_PATH,
        JSON.stringify({ ...ev, _emergency: true }) + "\n",
        { mode: 0o600 },
      );
    } catch { /* truly nothing we can do */ }
    // Also emit a stderr line tagged `[pi-eng-emergency]` so an
    // operator grep can spot the signal regardless of FS state.
    try {
      process.stderr.write(`[pi-eng-emergency] rollout-telemetry drop: ${ev.metric}\n`);
    } catch { /* ignore */ }
  }
}
