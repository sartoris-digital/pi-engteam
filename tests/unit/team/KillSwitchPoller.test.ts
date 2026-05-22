import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { KillSwitchPoller } from "../../../src/team/KillSwitchPoller.js";

describe("KillSwitchPoller", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pi-kspoller-test-"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeEnvFile(lines: string[]): void {
    writeFileSync(join(configDir, "kill-switches.env"), lines.join("\n") + "\n");
  }

  it("reads KEY=VALUE pairs from the env file", () => {
    writeEnvFile(["PI_ENGINEERING_LEGACY_MODE=1", "PI_ENGINEERING_TELEMETRY=true"]);
    const poller = new KillSwitchPoller({ configDir });
    expect(poller.get("PI_ENGINEERING_LEGACY_MODE")).toBe("1");
    expect(poller.get("PI_ENGINEERING_TELEMETRY")).toBe("true");
  });

  it("skips comment lines (# prefix)", () => {
    writeEnvFile([
      "# this is a comment",
      "PI_ENGINEERING_LEGACY_MODE=0",
      "# PI_ENGINEERING_TELEMETRY=should-be-ignored",
    ]);
    const poller = new KillSwitchPoller({ configDir });
    expect(poller.get("PI_ENGINEERING_LEGACY_MODE")).toBe("0");
    expect(poller.get("PI_ENGINEERING_TELEMETRY")).toBeUndefined();
  });

  it("returns undefined for keys absent from both file and process.env", () => {
    // No env file written.
    const poller = new KillSwitchPoller({ configDir });
    // Use a key that won't be set in the test environment.
    // We rely on the test runner not setting PI_ENGINEERING_CAPABILITY_MODE.
    const saved = process.env.PI_ENGINEERING_CAPABILITY_MODE;
    delete process.env.PI_ENGINEERING_CAPABILITY_MODE;
    try {
      expect(poller.get("PI_ENGINEERING_CAPABILITY_MODE")).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.PI_ENGINEERING_CAPABILITY_MODE = saved;
    }
  });

  it("file-defined values override process.env", () => {
    const testKey = "PI_ENGINEERING_TELEMETRY";
    const saved = process.env[testKey];
    process.env[testKey] = "from-env";
    try {
      writeEnvFile([`${testKey}=from-file`]);
      const poller = new KillSwitchPoller({ configDir });
      expect(poller.get(testKey)).toBe("from-file");
    } finally {
      if (saved !== undefined) process.env[testKey] = saved;
      else delete process.env[testKey];
    }
  });

  it("missing env file → values come from process.env only", () => {
    const testKey = "PI_ENGINEERING_LEGACY_MODE";
    const saved = process.env[testKey];
    process.env[testKey] = "env-only";
    try {
      // No kill-switches.env file.
      const poller = new KillSwitchPoller({ configDir });
      expect(poller.get(testKey)).toBe("env-only");
    } finally {
      if (saved !== undefined) process.env[testKey] = saved;
      else delete process.env[testKey];
    }
  });

  it("onChange fires when a value changes on next poll", () => {
    writeEnvFile(["PI_ENGINEERING_LEGACY_MODE=0"]);
    const changes: Array<{ next: string | undefined; prev: string | undefined }> = [];

    const poller = new KillSwitchPoller({
      configDir,
      pollIntervalMs: 1000,
      onChange: (next, prev) => {
        changes.push({
          next: next.PI_ENGINEERING_LEGACY_MODE,
          prev: prev.PI_ENGINEERING_LEGACY_MODE,
        });
      },
    });
    poller.start();

    // Update the file.
    writeEnvFile(["PI_ENGINEERING_LEGACY_MODE=1"]);

    // Advance timer past one poll interval.
    vi.advanceTimersByTime(1100);

    expect(changes).toHaveLength(1);
    expect(changes[0].prev).toBe("0");
    expect(changes[0].next).toBe("1");

    poller.stop();
  });

  it("onChange does NOT fire when values are unchanged", () => {
    writeEnvFile(["PI_ENGINEERING_LEGACY_MODE=0"]);
    const changes: unknown[] = [];

    const poller = new KillSwitchPoller({
      configDir,
      pollIntervalMs: 1000,
      onChange: () => changes.push(true),
    });
    poller.start();

    vi.advanceTimersByTime(3500); // 3 polls, no file change.

    expect(changes).toHaveLength(0);
    poller.stop();
  });

  it("getAll returns a snapshot of all tracked keys", () => {
    writeEnvFile([
      "PI_ENGINEERING_LEGACY_MODE=1",
      "PI_ENGINEERING_ACTIVITY_STREAM=true",
    ]);
    const poller = new KillSwitchPoller({ configDir });
    const all = poller.getAll();
    expect(all.PI_ENGINEERING_LEGACY_MODE).toBe("1");
    expect(all.PI_ENGINEERING_ACTIVITY_STREAM).toBe("true");
  });

  it("stop() prevents further onChange callbacks", () => {
    writeEnvFile(["PI_ENGINEERING_LEGACY_MODE=0"]);
    const changes: unknown[] = [];

    const poller = new KillSwitchPoller({
      configDir,
      pollIntervalMs: 500,
      onChange: () => changes.push(true),
    });
    poller.start();
    poller.stop();

    writeEnvFile(["PI_ENGINEERING_LEGACY_MODE=1"]);
    vi.advanceTimersByTime(2000);

    expect(changes).toHaveLength(0);
  });
});
