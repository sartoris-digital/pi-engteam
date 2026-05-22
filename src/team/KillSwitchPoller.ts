// Phase E item E6: kill-switch poller.
//
// Reads <configDir>/kill-switches.env on a configurable interval
// (default 5 s) and merges the result with process.env. File-defined
// values win on conflict so operators can override live without a
// restart. The timer is unref'd so it never keeps the process alive.
//
// Supported keys map 1-to-1 with Phase A + Phase B env vars so the
// operator can flip them without restarting the extension.
import { readFileSync } from "fs";
import { join } from "path";

export type KillSwitchValues = {
  PI_ENGINEERING_LEGACY_MODE?: string;
  PI_ENGINEERING_ACTIVITY_STREAM?: string;
  PI_ENGINEERING_CAPABILITY_MODE?: string;
  PI_ENGINEERING_VERDICT_SLOT_HOSTOWNED?: string;
  PI_ENGINEERING_ACCEPT_PREDICATES?: string;
  PI_ENGINEERING_FORCED_RETRIES?: string;
  PI_ENGINEERING_TELEMETRY?: string;
};

const KILL_SWITCH_KEYS: ReadonlyArray<keyof KillSwitchValues> = [
  "PI_ENGINEERING_LEGACY_MODE",
  "PI_ENGINEERING_ACTIVITY_STREAM",
  "PI_ENGINEERING_CAPABILITY_MODE",
  "PI_ENGINEERING_VERDICT_SLOT_HOSTOWNED",
  "PI_ENGINEERING_ACCEPT_PREDICATES",
  "PI_ENGINEERING_FORCED_RETRIES",
  "PI_ENGINEERING_TELEMETRY",
];

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class KillSwitchPoller {
  private readonly configDir: string;
  private readonly pollIntervalMs: number;
  private readonly onChange?: (next: KillSwitchValues, prev: KillSwitchValues) => void;
  private current: KillSwitchValues;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    configDir: string;
    pollIntervalMs?: number;
    onChange?: (next: KillSwitchValues, prev: KillSwitchValues) => void;
  }) {
    this.configDir = opts.configDir;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onChange = opts.onChange;
    this.current = this.readValues();
  }

  start(): void {
    if (this.timer !== null) return;
    const t = setInterval(() => this.poll(), this.pollIntervalMs);
    // unref so the timer does not keep the event loop alive.
    if (typeof t.unref === "function") t.unref();
    this.timer = t;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get(key: keyof KillSwitchValues): string | undefined {
    return this.current[key];
  }

  getAll(): KillSwitchValues {
    return { ...this.current };
  }

  // ------------------------------------------------------------------ private

  private poll(): void {
    const next = this.readValues();
    if (hasChanged(this.current, next)) {
      const prev = this.current;
      this.current = next;
      this.onChange?.(next, prev);
    }
  }

  private readValues(): KillSwitchValues {
    const fileValues = this.parseEnvFile();
    const result: KillSwitchValues = {};
    for (const key of KILL_SWITCH_KEYS) {
      // File wins over process.env when present.
      const fromFile = fileValues[key];
      if (fromFile !== undefined) {
        result[key] = fromFile;
      } else {
        const fromEnv = process.env[key];
        if (fromEnv !== undefined) {
          result[key] = fromEnv;
        }
      }
    }
    return result;
  }

  private parseEnvFile(): Partial<Record<string, string>> {
    const filePath = join(this.configDir, "kill-switches.env");
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return {};
    }

    const out: Partial<Record<string, string>> = {};
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();
      if (key) out[key] = value;
    }
    return out;
  }
}

// -------------------------------------------------------------------- helpers

function hasChanged(prev: KillSwitchValues, next: KillSwitchValues): boolean {
  for (const key of KILL_SWITCH_KEYS) {
    if (prev[key] !== next[key]) return true;
  }
  return false;
}
