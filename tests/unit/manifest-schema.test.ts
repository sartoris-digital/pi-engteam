import { describe, it, expect } from "vitest";
import {
  validateManifest,
  checkRequiredSecrets,
  type SecretsManifest,
} from "../../src/secrets/manifest.js";

describe("validateManifest", () => {
  it("fails when input is empty object", () => {
    const result = validateManifest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    }
  });

  it("passes with valid minimal manifest", () => {
    const result = validateManifest({ name: "ok", secrets: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.name).toBe("ok");
      expect(result.parsed.secrets).toEqual([]);
    }
  });

  it("passes with valid manifest containing one secret", () => {
    const result = validateManifest({
      name: "ok",
      secrets: [{ name: "X", env_var: "X", required: true }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.secrets).toHaveLength(1);
      expect(result.parsed.secrets[0]).toEqual({
        name: "X",
        env_var: "X",
        required: true,
      });
    }
  });

  it("fails with error for missing secret name field", () => {
    const result = validateManifest({
      name: "ok",
      secrets: [{ env_var: "X", required: true }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("secrets[0].name"))).toBe(true);
    }
  });

  it("fails with error for missing secret env_var field", () => {
    const result = validateManifest({
      name: "ok",
      secrets: [{ name: "X", required: true }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("secrets[0].env_var"))).toBe(true);
    }
  });

  it("fails with error for missing secret required field", () => {
    const result = validateManifest({
      name: "ok",
      secrets: [{ name: "X", env_var: "X" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("secrets[0].required"))).toBe(true);
    }
  });

  it("fails when secrets is not an array", () => {
    const result = validateManifest({ name: "ok", secrets: "not-an-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("secrets must be an array"))).toBe(true);
    }
  });

  it("fails when required is not a boolean", () => {
    const result = validateManifest({
      name: "ok",
      secrets: [{ name: "X", env_var: "X", required: "yes" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("secrets[0].required must be a boolean"))).toBe(true);
    }
  });

  it("fails with specific errors for multiple invalid secrets", () => {
    const result = validateManifest({
      name: "ok",
      secrets: [
        { name: "X", env_var: "X", required: true },
        { env_var: "Y", required: true },
        { name: "Z", env_var: "Z", required: "not-bool" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("secrets[1].name"))).toBe(true);
      expect(result.errors.some((e) => e.includes("secrets[2].required"))).toBe(true);
    }
  });
});

describe("checkRequiredSecrets", () => {
  it("returns ok=true with empty missing when all required secrets present", () => {
    const manifest: SecretsManifest = {
      name: "test",
      secrets: [
        { name: "KEY1", env_var: "KEY1", required: true },
        { name: "KEY2", env_var: "KEY2", required: true },
      ],
    };
    const result = checkRequiredSecrets(manifest, ["KEY1", "KEY2"]);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns ok=false with missing name when required secret not in vault", () => {
    const manifest: SecretsManifest = {
      name: "test",
      secrets: [
        { name: "KEY1", env_var: "KEY1", required: true },
        { name: "KEY2", env_var: "KEY2", required: true },
      ],
    };
    const result = checkRequiredSecrets(manifest, ["KEY1"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["KEY2"]);
  });

  it("returns ok=true when optional secret is missing", () => {
    const manifest: SecretsManifest = {
      name: "test",
      secrets: [
        { name: "KEY1", env_var: "KEY1", required: true },
        { name: "KEY2", env_var: "KEY2", required: false },
      ],
    };
    const result = checkRequiredSecrets(manifest, ["KEY1"]);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns ok=false with multiple missing required secrets", () => {
    const manifest: SecretsManifest = {
      name: "test",
      secrets: [
        { name: "A", env_var: "A", required: true },
        { name: "B", env_var: "B", required: true },
        { name: "C", env_var: "C", required: false },
      ],
    };
    const result = checkRequiredSecrets(manifest, ["D"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("A");
    expect(result.missing).toContain("B");
    expect(result.missing).not.toContain("C");
  });
});
