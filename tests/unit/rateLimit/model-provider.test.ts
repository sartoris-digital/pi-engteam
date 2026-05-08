import { describe, it, expect } from "vitest";
import { modelToProvider } from "../../../src/team/modelProvider.js";

describe("modelToProvider", () => {
  it("maps claude-* identifiers to anthropic", () => {
    expect(modelToProvider("claude-opus-4.6")).toBe("anthropic");
    expect(modelToProvider("claude-sonnet-4.6")).toBe("anthropic");
    expect(modelToProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
    expect(modelToProvider("claude-3-7-sonnet")).toBe("anthropic");
  });

  it("maps gpt-*, o1-*, o3-* to openai", () => {
    expect(modelToProvider("gpt-4o")).toBe("openai");
    expect(modelToProvider("gpt-5")).toBe("openai");
    expect(modelToProvider("o1-mini")).toBe("openai");
    expect(modelToProvider("o3-pro")).toBe("openai");
  });

  it("maps gemini-* to google", () => {
    expect(modelToProvider("gemini-3-flash")).toBe("google");
    expect(modelToProvider("gemini-2.5-pro")).toBe("google");
  });

  it("maps mistral-* and mixtral-* to mistral", () => {
    expect(modelToProvider("mistral-large")).toBe("mistral");
    expect(modelToProvider("mixtral-8x22b")).toBe("mistral");
  });

  it("returns 'unknown' for unrecognized identifiers", () => {
    expect(modelToProvider("llama-3-70b")).toBe("unknown");
    expect(modelToProvider("")).toBe("unknown");
    expect(modelToProvider("custom-model-xyz")).toBe("unknown");
  });

  it("is case-insensitive on the prefix", () => {
    expect(modelToProvider("Claude-Opus-4.6")).toBe("anthropic");
    expect(modelToProvider("GPT-4O")).toBe("openai");
  });
});
