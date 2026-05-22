import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CounterWal } from "../../../src/observability/counter-wal.js";
import { TextfileExporter } from "../../../src/observability/textfile-exporter.js";

describe("TextfileExporter", () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "tfe-"));
  });

  it("renders counters in Prometheus exposition format", () => {
    const wal = new CounterWal({ configDir });
    wal.inc("pi_eng_fallback_fired_total", { tier: "stdout-scan", agent: "bug-triage", step: "classify", provider: "copilot" }, 4);
    wal.flush();
    const exp = new TextfileExporter({ configDir, wal });
    const out = exp.render();
    expect(out).toContain("# HELP pi_eng_fallback_fired_total");
    expect(out).toContain("# TYPE pi_eng_fallback_fired_total counter");
    expect(out).toMatch(/pi_eng_fallback_fired_total\{[^}]+\} 4/);
  });

  it("renders gauges from caller-provided readers", () => {
    const exp = new TextfileExporter({
      configDir,
      gaugeReaders: [
        () => [
          { name: "pi_eng_activity_disk_usage_bytes", labels: { surface: "canonical" }, value: 1024 },
        ],
      ],
    });
    const out = exp.render();
    expect(out).toContain("# TYPE pi_eng_activity_disk_usage_bytes gauge");
    expect(out).toContain('pi_eng_activity_disk_usage_bytes{surface="canonical"} 1024');
  });

  it("writeOnce produces a per-pid fragment AND an aggregated metrics.prom", () => {
    const exp = new TextfileExporter({ configDir });
    const fragment = exp.writeOnce();
    expect(existsSync(fragment)).toBe(true);
    expect(existsSync(join(configDir, "telemetry", "metrics.prom"))).toBe(true);
  });

  it("aggregator skips stale fragments (>10× scrape interval old)", () => {
    const exp = new TextfileExporter({ configDir, scrapeIntervalMs: 1 });
    // Write a fragment with an obviously-old mtime.
    const path = join(configDir, "telemetry", `metrics.prom.99999`);
    const { writeFileSync, utimesSync, mkdirSync } = require("fs") as typeof import("fs");
    mkdirSync(join(configDir, "telemetry"), { recursive: true });
    writeFileSync(path, "# stale fragment\n");
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(path, old, old);
    exp.aggregate();
    expect(existsSync(path)).toBe(false);
  });

  it("escapes label values with embedded quotes/newlines", () => {
    const exp = new TextfileExporter({
      configDir,
      gaugeReaders: [
        () => [
          { name: "pi_eng_activity_disk_usage_bytes", labels: { surface: 'has"quote\\path' }, value: 1 },
        ],
      ],
    });
    const out = exp.render();
    expect(out).toContain('surface="has\\"quote\\\\path"');
  });

  // E5: write failure routes to emergency spool
  it("E5: write failure routes to emergency spool", () => {
    const spoolPath = join(mkdtempSync(join(tmpdir(), "spool-")), "emergency.jsonl");
    const origEnv = process.env["PI_ENGINEERING_EMERGENCY_SPOOL"];
    process.env["PI_ENGINEERING_EMERGENCY_SPOOL"] = spoolPath;

    try {
      // Make the telemetry dir read-only so writeFileSync fails.
      const telemetryDir = join(configDir, "telemetry");
      mkdirSync(telemetryDir, { recursive: true });
      // Make dir read-only (chmod 0444) so writes fail.
      require("fs").chmodSync(telemetryDir, 0o444);

      const exp = new TextfileExporter({ configDir });
      // writeOnce should not throw even when the write fails.
      expect(() => exp.writeOnce()).not.toThrow();

      // Restore permissions before assertion reads.
      require("fs").chmodSync(telemetryDir, 0o755);

      // Emergency spool should have received an entry.
      expect(existsSync(spoolPath)).toBe(true);
      const lines = readFileSync(spoolPath, "utf8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const entry = JSON.parse(lines[0]);
      expect(entry.kind).toBe("alert");
      expect(entry.reason).toBe("export-write-failed");
    } finally {
      try { require("fs").chmodSync(join(configDir, "telemetry"), 0o755); } catch { /* ignore */ }
      if (origEnv === undefined) {
        delete process.env["PI_ENGINEERING_EMERGENCY_SPOOL"];
      } else {
        process.env["PI_ENGINEERING_EMERGENCY_SPOOL"] = origEnv;
      }
    }
  });

  // E8: pre-existing lock file causes aggregate() to skip without error
  it("E8: aggregator lock prevents double-write when lock already held", () => {
    const telemetryDir = join(configDir, "telemetry");
    mkdirSync(telemetryDir, { recursive: true });

    // Pre-create the lock file to simulate another process holding it.
    const lockPath = join(telemetryDir, ".aggregator.lock");
    writeFileSync(lockPath, "99999");

    const exp = new TextfileExporter({ configDir });
    // Should return without error and without writing metrics.prom.
    expect(() => exp.aggregate()).not.toThrow();
    expect(existsSync(join(telemetryDir, "metrics.prom"))).toBe(false);
    // Lock file should still exist (we didn't remove it).
    expect(existsSync(lockPath)).toBe(true);
  });

  // E5: threshold breach appends to alerts.jsonl
  it("E5: threshold breach appends to alerts.jsonl", () => {
    const exp = new TextfileExporter({
      configDir,
      gaugeReaders: [
        () => [
          { name: "pi_eng_activity_disk_usage_bytes", labels: { surface: "canonical" }, value: 2000 },
        ],
      ],
      alertThresholds: [
        { name: "pi_eng_activity_disk_usage_bytes", threshold: 1000, direction: "above" },
      ],
    });

    exp.writeOnce();

    const alertsPath = join(configDir, "telemetry", "alerts.jsonl");
    expect(existsSync(alertsPath)).toBe(true);
    const lines = readFileSync(alertsPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const alert = JSON.parse(lines[0]);
    expect(alert.name).toBe("pi_eng_activity_disk_usage_bytes");
    expect(alert.value).toBe(2000);
    expect(alert.threshold).toBe(1000);
    expect(alert.direction).toBe("above");
  });
});
