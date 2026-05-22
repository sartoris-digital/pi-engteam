import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RolloutTelemetry, ROLLOUT_TELEMETRY_METRICS } from "../../../src/observability/rollout-telemetry.js";

describe("RolloutTelemetry", () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "rollout-tel-"));
  });

  it("emits cataloged rollout metrics to rollout.jsonl", () => {
    const r = new RolloutTelemetry({ configDir });
    r.emit("pi_eng_workflow_success_total", { workflow: "triage", cohort: "c001" });
    const path = join(configDir, "telemetry", "rollout.jsonl");
    expect(existsSync(path)).toBe(true);
    const line = readFileSync(path, "utf8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.metric).toBe("pi_eng_workflow_success_total");
    expect(parsed.labels.cohort).toBe("c001");
  });

  it("silently no-ops for metrics outside the always-on subset", () => {
    const r = new RolloutTelemetry({ configDir });
    r.emit("pi_eng_stuck_warning_total", { kind: "model-silent" });
    expect(existsSync(join(configDir, "telemetry", "rollout.jsonl"))).toBe(false);
  });

  it("drops over-cap events with the cataloged drop counter", () => {
    const r = new RolloutTelemetry({ configDir, dailyCapBytes: 100 });
    // Pre-create a near-full file so the next emit exceeds the cap.
    writeFileSync(join(configDir, "telemetry", "rollout.jsonl"), "x".repeat(90));
    r.emit("pi_eng_workflow_success_total", { workflow: "triage", cohort: "c001" });
    expect(r.getDropCount()).toBe(1);
  });

  it("always-on subset includes the workflow + fallback + capability metrics per E16", () => {
    expect(ROLLOUT_TELEMETRY_METRICS.has("pi_eng_workflow_success_total")).toBe(true);
    expect(ROLLOUT_TELEMETRY_METRICS.has("pi_eng_fallback_fired_total")).toBe(true);
    expect(ROLLOUT_TELEMETRY_METRICS.has("pi_eng_verdict_timeout_total")).toBe(true);
    expect(ROLLOUT_TELEMETRY_METRICS.has("pi_eng_capability_mismatch_total")).toBe(true);
    expect(ROLLOUT_TELEMETRY_METRICS.has("pi_eng_feature_gate_breach_total")).toBe(true);
    expect(ROLLOUT_TELEMETRY_METRICS.has("pi_eng_protection_block_total")).toBe(true);
  });
});
