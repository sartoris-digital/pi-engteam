import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const { readLastNTurns } = await import(
  "../../../src/assets/second-brain/scripts/lib/transcript.mjs"
);

function makeJSONL(messages: Array<Record<string, unknown>>): string {
  return `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
}

describe("readLastNTurns", () => {
  it("returns a placeholder when the transcript file does not exist", async () => {
    const result = await readLastNTurns("/nonexistent/path/session.jsonl", 5);

    expect(result).toBe("(no transcript available)");
  });

  it("reads the last N simple role/content messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-transcript-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      makeJSONL([
        { role: "user", content: "First message" },
        { role: "assistant", content: "First reply" },
        { role: "user", content: "Second message" },
        { role: "assistant", content: "Second reply" },
        { role: "user", content: "Third message" },
        { role: "assistant", content: "Third reply" },
      ]),
      "utf8",
    );

    const result = await readLastNTurns(path, 2);

    expect(result).toContain("Third message");
    expect(result).toContain("Third reply");
    expect(result).not.toContain("First message");
  });

  it("skips malformed and non-message JSONL lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-transcript-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "tool_call", name: "Read" }),
        JSON.stringify({ role: "user", content: "Hello" }),
        "not-valid-json",
        JSON.stringify({ role: "assistant", content: "Hi there" }),
      ].join("\n"),
      "utf8",
    );

    const result = await readLastNTurns(path, 10);

    expect(result).toContain("Hello");
    expect(result).toContain("Hi there");
    expect(result).not.toContain("tool_call");
  });

  it("handles block-based content arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-transcript-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      makeJSONL([
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello from block" }],
        },
      ]),
      "utf8",
    );

    const result = await readLastNTurns(path, 5);

    expect(result).toContain("Hello from block");
  });

  it("handles Pi session manager message entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-transcript-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      makeJSONL([
        { type: "session", id: "header", timestamp: "2026-04-15T10:00:00Z", cwd: "/tmp" },
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-04-15T10:00:01Z",
          message: {
            role: "user",
            content: "Explain the bug",
          },
        },
        {
          type: "message",
          id: "m2",
          parentId: "m1",
          timestamp: "2026-04-15T10:00:02Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The bug is in auth." }],
          },
        },
      ]),
      "utf8",
    );

    const result = await readLastNTurns(path, 5);

    expect(result).toContain("Explain the bug");
    expect(result).toContain("The bug is in auth.");
  });
});
