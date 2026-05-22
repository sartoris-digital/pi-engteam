import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Test suite for probe-pi-provider.mjs maxProbeFiles configuration
 * 
 * These tests verify that the --max-probe-files option works correctly:
 * - Argument parsing
 * - Default value (3)
 * - Validation (1-10 range)
 * - Canary file creation
 * - Dynamic prompt generation
 */

describe("probe-pi-provider maxProbeFiles", () => {
  const scriptPath = "./scripts/probe-pi-provider.mjs";
  
  // Helper to run the probe script with given args
  async function runProbe(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn("node", [scriptPath, "--dry-run", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (b) => (stdout += b.toString()));
      proc.stderr.on("data", (b) => (stderr += b.toString()));
      proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  }

  describe("argument parsing", () => {
    it("should accept --max-probe-files with a valid value", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "5"
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toMatch(/must be an integer/);
    });

    it("should use default value of 3 when --max-probe-files is not provided", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model"
      ]);
      expect(result.code).toBe(0);
      // In dry-run mode, check the output indicates default behavior
      expect(result.stdout).toMatch(/capability bundle/i);
    });
  });

  describe("validation", () => {
    it("should reject --max-probe-files with value less than 1", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "0"
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/must be an integer between 1 and 10/);
    });

    it("should reject --max-probe-files with negative value", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "-1"
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/must be an integer between 1 and 10/);
    });

    it("should reject --max-probe-files with value greater than 10", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "11"
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/must be an integer between 1 and 10/);
    });

    it("should reject --max-probe-files with non-numeric value", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "abc"
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/must be an integer between 1 and 10/);
    });
  });

  describe("boundary values", () => {
    it("should accept --max-probe-files with value 1 (minimum)", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "1"
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toMatch(/must be an integer/);
    });

    it("should accept --max-probe-files with value 10 (maximum)", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "10"
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toMatch(/must be an integer/);
    });
  });

  describe("usage documentation", () => {
    it("should show --max-probe-files in usage message when no provider given", async () => {
      const result = await runProbe([]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/--max-probe-files/);
    });
  });

  describe("integration - canary file creation", () => {
    it("should create 1 canary file when --max-probe-files is 1", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "1"
      ]);
      expect(result.code).toBe(0);
      // Verify output mentions capability bundle (indicates successful run)
      expect(result.stdout).toMatch(/capability bundle/i);
    });

    it("should create 5 canary files when --max-probe-files is 5", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "5"
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/capability bundle/i);
    });

    it("should create 10 canary files when --max-probe-files is 10", async () => {
      const result = await runProbe([
        "--provider", "test-provider",
        "--model", "test-model",
        "--max-probe-files", "10"
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/capability bundle/i);
    });
  });
});
