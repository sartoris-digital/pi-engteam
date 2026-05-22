import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
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
});
