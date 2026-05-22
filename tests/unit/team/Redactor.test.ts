import { describe, it, expect } from "vitest";
import { redact, redactForTerminal, redactForSse, redactForHtml, redactForPrompt, StreamingRedactor } from "../../../src/team/Redactor.js";

describe("Redactor — pattern matches", () => {
  it("redacts a GitHub classic PAT", () => {
    const out = redact("token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0123 and more");
    expect(out).toMatch(/\[REDACTED:github-pat-classic/);
    expect(out).not.toContain("ghp_AAAA");
  });

  it("redacts an OpenAI sk- key", () => {
    const out = redact("key sk-1234567890abcdef1234567890abcdef end");
    expect(out).toMatch(/\[REDACTED:openai-sk/);
  });

  it("redacts an Anthropic sk-ant key", () => {
    const out = redact("key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII end");
    expect(out).toMatch(/\[REDACTED:anthropic-sk-ant/);
  });

  it("redacts AWS access key shape", () => {
    const out = redact("aws=AKIA1234567890ABCDEF rest");
    expect(out).toMatch(/\[REDACTED:aws-access-key/);
  });

  it("redacts JWT-shaped strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redact(`token=${jwt}`);
    expect(out).toMatch(/\[REDACTED:jwt/);
  });

  it("redacts env-style assignments while preserving the key name", () => {
    const out = redact('GH_TOKEN="ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0123"');
    expect(out).toMatch(/GH_TOKEN.*\[REDACTED:/);
    expect(out).not.toContain("ghp_AAAA");
  });

  it("leaves non-secret text intact", () => {
    const out = redact("plain text with no secrets");
    expect(out).toBe("plain text with no secrets");
  });
});

describe("Redactor — output formatters", () => {
  it("redactForTerminal strips ANSI escape sequences", () => {
    const out = redactForTerminal("\x1b[31mred\x1b[0m text");
    expect(out).not.toContain("\x1b");
    expect(out).toBe("red text");
  });

  it("redactForSse JSON-encodes the output", () => {
    const out = redactForSse('sk-1234567890abcdef1234567890abcdef\n"quoted"');
    expect(out.startsWith('"')).toBe(true);
    expect(out).toContain("REDACTED");
    expect(out).toContain('\\"quoted\\"');
  });

  it("redactForHtml HTML-escapes the output", () => {
    const out = redactForHtml('<script>alert("xss")</script>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("redactForPrompt truncates to maxBytes", () => {
    const big = "x".repeat(8 * 1024);
    const out = redactForPrompt(big, 1024);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("TRUNCATED");
  });
});

describe("StreamingRedactor", () => {
  it("redacts content that straddles chunk boundaries", () => {
    const r = new StreamingRedactor();
    // Split a known secret in half across two chunks.
    const secret = "sk-1234567890abcdef1234567890abcdef";
    const a = secret.slice(0, 10);
    const b = secret.slice(10);
    let out = r.push(`prefix ${a}`);
    out += r.push(`${b} suffix`);
    out += r.flush();
    expect(out).toContain("REDACTED");
    expect(out).not.toContain(secret);
  });

  it("emits redacted content for non-straddling chunks too", () => {
    const r = new StreamingRedactor();
    let out = r.push("hello sk-1234567890abcdef1234567890abcdef end ");
    out += r.push("more text here without any secrets at all that pushes past the overlap window so the head flushes");
    out += r.flush();
    expect(out).toContain("REDACTED");
  });
});
