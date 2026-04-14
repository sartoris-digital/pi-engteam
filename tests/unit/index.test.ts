import { describe, it, expect, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({}));

describe("extension entry point", () => {
  it("exports a default async function", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof mod.default).toBe("function");
  });
});
