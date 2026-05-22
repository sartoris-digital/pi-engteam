// Phase E item E7 — Phase-B chaos / load harness.
//
// Injects failure modes against the activity queue and asserts the
// SLOs hold:
//   - slow fsync → ring drains, essential events coalesce, auto-
//     disable latches after 3 coalesces in 60s.
//   - hung consumer → producer never blocks; per-consumer ring
//     sheds load locally.
//   - saturated ring (synthetic high event rate) → thinking
//     drops, essentials preserved.
//   - hostile verbose subprocess → redactor + truncation hold.
//
// These are in-process simulations (no real subprocess). The full
// system-level chaos (fsync delays, FS faults) needs containerized
// CI which is out of scope here.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunActivityQueue } from "../../src/team/RunActivityQueue.js";

describe("Phase-B chaos harness — round 4 + round 11 SLOs", () => {
  let runsDir: string;
  const runId = "chaos-run-1111";

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "chaos-"));
  });

  it("saturated ring drops thinking events but never blocks", () => {
    const q = new RunActivityQueue({ runsDir, runId, ringCapacity: 4 });
    // Pre-fill with essentials.
    for (let i = 0; i < 4; i++) {
      q.enqueue({ runId, agentName: "a", step: "s", kind: "tool_call_invoke", body: `cmd-${i}`, sourceClass: "stdout" });
    }
    // Burst 1000 thinking events — none should hang or throw.
    let dropped = 0;
    for (let i = 0; i < 1000; i++) {
      const r = q.enqueue({ runId, agentName: "a", step: "s", kind: "thinking", body: `t-${i}`, sourceClass: "stdout" });
      if (!r.accepted) dropped++;
    }
    expect(dropped).toBeGreaterThan(0); // ring was full, drops fired
    expect(q.isAutoDisabled()).toBe(false); // thinking drops never trigger auto-disable
  });

  it("essential coalescing latches auto-disable after sustained pressure", () => {
    const q = new RunActivityQueue({ runsDir, runId, ringCapacity: 1 });
    // Fill the ring.
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "fill", sourceClass: "stdout" });
    // Send 5 essentials back-to-back — 4th should latch the auto-
    // disable per the >3-coalesces-in-60s rule.
    for (let i = 0; i < 5; i++) {
      q.enqueue({ runId, agentName: "a", step: "s", kind: "verdict", body: `v-${i}`, sourceClass: "stdout" });
    }
    expect(q.isAutoDisabled()).toBe(true);
  });

  it("once auto-disabled, every subsequent enqueue is dropped", () => {
    const q = new RunActivityQueue({ runsDir, runId, ringCapacity: 1 });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "fill", sourceClass: "stdout" });
    for (let i = 0; i < 5; i++) {
      q.enqueue({ runId, agentName: "a", step: "s", kind: "verdict", body: `v-${i}`, sourceClass: "stdout" });
    }
    const after = q.enqueue({ runId, agentName: "a", step: "s", kind: "verdict", body: "post", sourceClass: "stdout" });
    expect(after.accepted).toBe(false);
  });

  it("body truncation holds under a hostile-verbose burst", () => {
    const q = new RunActivityQueue({ runsDir, runId, ringCapacity: 64, maxBodyBytes: 64 });
    const big = "x".repeat(64 * 1024);
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: big, sourceClass: "stdout" });
    const jsonl = readFileSync(q.jsonlPath, "utf8");
    const ev = JSON.parse(jsonl.trim().split("\n")[0]);
    expect(ev.body.length).toBeLessThan(big.length);
    expect(ev.body).toMatch(/TRUNCATED|REDACTED/);
  });

  it("secret in a hostile body is redacted before persist (Phase C item 18)", () => {
    const q = new RunActivityQueue({ runsDir, runId, ringCapacity: 4 });
    q.enqueue({
      runId, agentName: "a", step: "s",
      kind: "assistant_text",
      body: "leaked sk-1234567890abcdef1234567890abcdef trailing text",
      sourceClass: "stdout",
    });
    const jsonl = readFileSync(q.jsonlPath, "utf8");
    expect(jsonl).toContain("REDACTED");
    expect(jsonl).not.toContain("sk-1234567890abcdef1234567890abcdef");
  });

  it("simulated long-running per-step volume cap collapses to a summary", () => {
    // Small cap for the test — 1 KB per step. Real default is 8 MB.
    const q = new RunActivityQueue({
      runsDir, runId, ringCapacity: 256, maxBodyBytes: 256,
      stepVolumeByteCap: 1024,
      stepVolumeCountCap: 10_000,
    });
    const big = "x".repeat(256);
    // Enough events to push past the 1 KB byte cap.
    for (let i = 0; i < 50; i++) {
      q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: big, sourceClass: "stdout" });
    }
    // Now admit an essential event — it should emit the
    // suppression-summary line.
    q.enqueue({ runId, agentName: "a", step: "s", kind: "verdict", body: "PASS", sourceClass: "stdout" });
    const jsonl = readFileSync(q.jsonlPath, "utf8");
    expect(jsonl).toContain("essential-coalesced");
    expect(jsonl).toMatch(/non-essential events suppressed/);
  });
});
