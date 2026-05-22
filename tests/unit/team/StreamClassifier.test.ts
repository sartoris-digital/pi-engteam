import { describe, it, expect } from "vitest";
import { classifyChunk } from "../../../src/team/StreamClassifier.js";

describe("StreamClassifier", () => {
  it("classifies stderr chunks as error", () => {
    const r = classifyChunk("oops something failed", "stderr");
    expect(r.kind).toBe("error");
  });

  it("recognises 'thinking:' prefix on stdout", () => {
    const r = classifyChunk("thinking: planning the next step", "stdout");
    expect(r.kind).toBe("thinking");
  });

  it("recognises italic one-liners as thinking", () => {
    const r = classifyChunk("*reading the bug report*", "stdout");
    expect(r.kind).toBe("thinking");
  });

  it("recognises shell-style tool invocations", () => {
    const r = classifyChunk("$ git status --short", "stdout");
    expect(r.kind).toBe("tool_call_invoke");
  });

  it("recognises tool_result prefix", () => {
    const r = classifyChunk("tool_result: file written", "stdout");
    expect(r.kind).toBe("tool_call_result");
  });

  it("recognises 'error:' prefix on stdout", () => {
    const r = classifyChunk("Error: divide by zero", "stdout");
    expect(r.kind).toBe("error");
  });

  it("falls back to assistant_text for plain prose", () => {
    const r = classifyChunk("The bug is in the consent middleware.", "stdout");
    expect(r.kind).toBe("assistant_text");
  });

  it("returns the original body unchanged", () => {
    const r = classifyChunk("verbatim chunk content", "stdout");
    expect(r.body).toBe("verbatim chunk content");
  });

  it("returns assistant_text + non-empty for empty stdout chunks", () => {
    const r = classifyChunk("", "stdout");
    expect(r.kind).toBe("assistant_text");
  });
});
