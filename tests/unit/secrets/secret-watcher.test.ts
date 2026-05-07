import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PATTERNS,
  loadUserPatterns,
} from "../../../src/secrets/patterns.js";
import {
  scan,
  rewriteWithPlaceholders,
  shannonEntropy,
  entropyFlag,
} from "../../../src/secrets/Watcher.js";

const A20 = "A".repeat(20);
const A36 = "A".repeat(36);
const A40 = "A".repeat(40);
const A82 = "A".repeat(82);
const HEX40 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function findByName(matches: ReturnType<typeof scan>, name: string) {
  return matches.find((m) => m.pattern.name === name);
}

describe("DEFAULT_PATTERNS coverage", () => {
  const cases: Array<{ name: string; suggested: string; fixture: string }> = [
    { name: "Anthropic API key", suggested: "ANTHROPIC_API_KEY", fixture: `prefix sk-ant-${A20} suffix` },
    { name: "OpenAI API key", suggested: "OPENAI_API_KEY", fixture: `prefix sk-${A40} suffix` },
    { name: "OpenAI project key", suggested: "OPENAI_API_KEY", fixture: `prefix sk-proj-${A40} suffix` },
    { name: "GitHub personal token", suggested: "GITHUB_TOKEN", fixture: `prefix ghp_${A36} suffix` },
    { name: "GitHub OAuth", suggested: "GITHUB_OAUTH_TOKEN", fixture: `prefix gho_${A36} suffix` },
    { name: "GitHub fine-grained PAT", suggested: "GITHUB_PAT", fixture: `prefix github_pat_${A82} suffix` },
    { name: "Slack token", suggested: "SLACK_TOKEN", fixture: "prefix xoxb-1234-5678-AAAAaaaaBBBBbbbb suffix" },
    { name: "AWS access key", suggested: "AWS_ACCESS_KEY_ID", fixture: `prefix AKIA${"A".repeat(16)} suffix` },
    {
      name: "AWS secret access key",
      suggested: "AWS_SECRET_ACCESS_KEY",
      fixture: `aws_secret_access_key=${"a".repeat(40)}`,
    },
    {
      name: "JWT (3-part Base64URL)",
      suggested: "JWT_TOKEN",
      fixture: `tok=eyJ${A20}.${A20}.${A20}`,
    },
  ];

  for (const c of cases) {
    it(`detects ${c.name}`, () => {
      const matches = scan(c.fixture);
      const matchingByPattern = matches.filter((m) => m.pattern.name === c.name);
      expect(matchingByPattern.length).toBe(1);
      const match = matchingByPattern[0];
      expect(match.pattern.suggestedName).toBe(c.suggested);
      // Preview shape: long values truncated to 6 + "..." + 4
      if (match.value.length >= 10) {
        expect(match.preview).toBe(`${match.value.slice(0, 6)}...${match.value.slice(-4)}`);
      } else {
        expect(match.preview).toBe(match.value);
      }
    });
  }

  it("ships exactly 10 default patterns", () => {
    expect(DEFAULT_PATTERNS.length).toBe(10);
  });
});

describe("priority ordering", () => {
  it("sk-proj- wins over generic sk- on the same bytes", () => {
    const input = `key sk-proj-${A40} end`;
    const matches = scan(input);
    // Only one match should cover the secret region; it must be the project pattern.
    expect(matches.length).toBe(1);
    expect(matches[0].pattern.name).toBe("OpenAI project key");
    expect(matches[0].pattern.suggestedName).toBe("OPENAI_API_KEY");
  });

  it("sk-ant- wins over generic sk- on the same bytes", () => {
    const input = `key sk-ant-${A40} end`;
    const matches = scan(input);
    expect(matches.length).toBe(1);
    expect(matches[0].pattern.name).toBe("Anthropic API key");
  });
});

describe("JWT structural requirement", () => {
  it("does not match a plain hex hash without 3-part dotted structure", () => {
    const input = `hash=${HEX40}${HEX40}`;
    const matches = scan(input);
    expect(findByName(matches, "JWT (3-part Base64URL)")).toBeUndefined();
  });

  it("does not match a 2-part eyJ string (missing third segment)", () => {
    const input = `tok=eyJ${A20}.${A20}`;
    const matches = scan(input);
    expect(findByName(matches, "JWT (3-part Base64URL)")).toBeUndefined();
  });
});

describe("entropy heuristic", () => {
  // Use a base64-ish 40-char string with high diversity so entropy clears 4.5
  const HIGH_ENTROPY_40 = "aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP9lO8mN7o";

  it("OFF by default: 40-char high-entropy string returns no synthetic match", () => {
    const matches = scan(`junk ${HIGH_ENTROPY_40} junk`);
    expect(findByName(matches, "High-entropy candidate")).toBeUndefined();
  });

  it("ON: 40-char high-entropy string yields synthetic match", () => {
    const matches = scan(`junk ${HIGH_ENTROPY_40} junk`, {
      entropy: { enabled: true, minLength: 32, minBitsPerChar: 4.5 },
    });
    const ent = findByName(matches, "High-entropy candidate");
    expect(ent).toBeDefined();
    expect(ent!.pattern.suggestedName).toBe("UNNAMED_SECRET");
    expect(ent!.value).toBe(HIGH_ENTROPY_40);
  });

  it("ON: does not double-flag a region already matched by a known pattern", () => {
    const input = `key sk-ant-${A40} end`;
    const matches = scan(input, {
      entropy: { enabled: true, minLength: 16, minBitsPerChar: 1 },
    });
    const ant = findByName(matches, "Anthropic API key");
    const ent = findByName(matches, "High-entropy candidate");
    expect(ant).toBeDefined();
    if (ent) {
      // Any entropy match must NOT overlap the known-pattern range.
      const overlap = ent.start < ant!.end && ent.end > ant!.start;
      expect(overlap).toBe(false);
    }
  });

  it("shannonEntropy returns 0 for empty string", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("shannonEntropy of a uniform single-char string is 0", () => {
    expect(shannonEntropy("aaaaaa")).toBe(0);
  });

  it("entropyFlag respects enabled flag", () => {
    const out = entropyFlag(HIGH_ENTROPY_40, {
      enabled: false,
      minLength: 10,
      minBitsPerChar: 1,
    });
    expect(out).toEqual([]);
  });
});

describe("rewriteWithPlaceholders", () => {
  it("replaces a matched secret with ${SECRET:NAME}", () => {
    const value = `sk-ant-${A20}`;
    const input = `my key is ${value}, ok?`;
    const matches = scan(input);
    expect(matches.length).toBe(1);
    const { rewritten, placeholders } = rewriteWithPlaceholders(input, matches);
    expect(rewritten).toBe("my key is ${SECRET:ANTHROPIC_API_KEY}, ok?");
    expect(placeholders).toEqual([{ name: "ANTHROPIC_API_KEY", original: value }]);
  });

  it("handles multiple distinct matches in order", () => {
    const v1 = `sk-ant-${A20}`;
    const v2 = `ghp_${A36}`;
    const input = `a=${v1} b=${v2}`;
    const matches = scan(input);
    const { rewritten, placeholders } = rewriteWithPlaceholders(input, matches);
    expect(rewritten).toBe("a=${SECRET:ANTHROPIC_API_KEY} b=${SECRET:GITHUB_TOKEN}");
    expect(placeholders.map((p) => p.name)).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
  });
});

describe("preview truncation", () => {
  it("short value (<10 chars) is shown in full as preview", () => {
    // Use a custom pattern that will yield a 4-char value.
    const matches = scan("foo abcd bar", {
      patterns: [
        { name: "tiny", regex: /abcd/g, suggestedName: "TINY", priority: 0 },
      ],
    });
    expect(matches.length).toBe(1);
    expect(matches[0].preview).toBe("abcd");
  });

  it("long value uses first 6 + '...' + last 4", () => {
    const value = `sk-ant-${A20}`;
    const matches = scan(`x ${value} y`);
    expect(matches.length).toBe(1);
    expect(matches[0].preview).toBe(`${value.slice(0, 6)}...${value.slice(-4)}`);
  });

  it("exactly 10 chars uses first 6 + '...' + last 4", () => {
    const matches = scan("abcdefghij", {
      patterns: [
        { name: "ten", regex: /abcdefghij/g, suggestedName: "TEN", priority: 0 },
      ],
    });
    expect(matches.length).toBe(1);
    expect(matches[0].preview).toBe("abcdef...ghij");
  });
});

describe("loadUserPatterns", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-patterns-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array when file does not exist", () => {
    expect(loadUserPatterns(join(dir, "nope.json"))).toEqual([]);
  });

  it("parses a valid file", () => {
    const path = join(dir, "valid.json");
    writeFileSync(
      path,
      JSON.stringify([
        { name: "MyToken", regex: "myco_[A-Za-z0-9]{10}", suggestedName: "MYCO_TOKEN", priority: 100 },
      ]),
    );
    const patterns = loadUserPatterns(path);
    expect(patterns.length).toBe(1);
    expect(patterns[0].name).toBe("MyToken");
    expect(patterns[0].suggestedName).toBe("MYCO_TOKEN");
    expect(patterns[0].priority).toBe(100);
    expect(patterns[0].regex).toBeInstanceOf(RegExp);
    expect(patterns[0].regex.flags).toContain("g");
  });

  it("rejects an invalid regex with a structured error", () => {
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify([
        { name: "Broken", regex: "[unterminated", suggestedName: "BROKEN", priority: 0 },
      ]),
    );
    let err: unknown;
    try {
      loadUserPatterns(path);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Broken");
    expect((err as Error).message).toContain("invalid regex");
  });

  it("rejects malformed entries with a structured error", () => {
    const path = join(dir, "malformed.json");
    writeFileSync(path, JSON.stringify([{ name: "Foo" }]));
    expect(() => loadUserPatterns(path)).toThrow(/regex/);
  });
});

describe("scan determinism", () => {
  it("returns matches sorted by start offset", () => {
    const input = `${`ghp_${A36}`} middle ${`sk-ant-${A20}`}`;
    const matches = scan(input);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].start).toBeGreaterThanOrEqual(matches[i - 1].start);
    }
  });
});
