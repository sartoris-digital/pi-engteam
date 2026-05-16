// src/secrets/patterns.ts
import { readFileSync } from "node:fs";

export type SecretPattern = {
  name: string;
  regex: RegExp;
  suggestedName: string;
  priority: number;
  captureGroup?: number;
};

// Order matters: more-specific prefixes (sk-proj-, sk-ant-) MUST evaluate before
// the generic sk- pattern. Priority numbers encode that ordering and survive
// concatenation with user patterns + sort.
export const DEFAULT_PATTERNS: SecretPattern[] = [
  {
    name: "Anthropic API key",
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    suggestedName: "ANTHROPIC_API_KEY",
    priority: 0,
  },
  {
    name: "OpenAI project key",
    regex: /sk-proj-[A-Za-z0-9_-]{40,}/g,
    suggestedName: "OPENAI_API_KEY",
    priority: 1,
  },
  {
    name: "OpenAI API key",
    regex: /sk-[A-Za-z0-9]{40,}/g,
    suggestedName: "OPENAI_API_KEY",
    priority: 2,
  },
  {
    name: "GitHub fine-grained PAT",
    regex: /github_pat_[A-Za-z0-9_]{82}/g,
    suggestedName: "GITHUB_PAT",
    priority: 3,
  },
  {
    name: "GitHub personal token",
    regex: /ghp_[A-Za-z0-9]{36}/g,
    suggestedName: "GITHUB_TOKEN",
    priority: 4,
  },
  {
    name: "GitHub OAuth",
    regex: /gho_[A-Za-z0-9]{36}/g,
    suggestedName: "GITHUB_OAUTH_TOKEN",
    priority: 5,
  },
  {
    name: "Slack token",
    regex: /xox[bp]-\d+-\d+-[A-Za-z0-9]+/g,
    suggestedName: "SLACK_TOKEN",
    priority: 6,
  },
  {
    name: "AWS access key",
    regex: /AKIA[0-9A-Z]{16}/g,
    suggestedName: "AWS_ACCESS_KEY_ID",
    priority: 7,
  },
  // Limitation: only matches when the secret is assigned via `=` or `:` since AWS
  // secret keys have no distinguishing prefix and are otherwise indistinguishable
  // from arbitrary base64.
  {
    name: "AWS secret access key",
    regex: /aws_secret_access_key\s*[=:]\s*([A-Za-z0-9/+=]{40})/gi,
    suggestedName: "AWS_SECRET_ACCESS_KEY",
    priority: 8,
    captureGroup: 1,
  },
  {
    name: "JWT (3-part Base64URL)",
    regex: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    suggestedName: "JWT_TOKEN",
    priority: 9,
  },
];

type RawUserPattern = {
  name?: unknown;
  regex?: unknown;
  suggestedName?: unknown;
  priority?: unknown;
};

export function loadUserPatterns(path: string): SecretPattern[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`secret-patterns.json: invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("secret-patterns.json: expected an array of patterns");
  }

  const out: SecretPattern[] = [];
  for (let idx = 0; idx < parsed.length; idx++) {
    const compiled = compileUserPattern(parsed[idx] as RawUserPattern, idx);
    if (matchesEmptyString(compiled.regex)) {
      console.warn(
        `secret-patterns.json[${idx}] '${compiled.name}': regex matches empty string; skipping (would cause infinite loop)`,
      );
      continue;
    }
    out.push(compiled);
  }
  return out;
}

function matchesEmptyString(re: RegExp): boolean {
  const probe = new RegExp(re.source, re.flags);
  probe.lastIndex = 0;
  const m = probe.exec("");
  return m !== null && m[0].length === 0;
}

// Codex round-5 MEDIUM: user-supplied regexes can ReDoS the input hook
// because Watcher.scan runs them synchronously on every keystroke. Reject
// patterns with the textbook catastrophic-backtracking shapes — nested
// quantifiers like `(a+)+`, `(a*)*`, `(a+)*` — and cap source length.
// This is a heuristic (a true safe-regex check would require either a
// dependency or a non-backtracking engine like RE2), but it catches the
// shapes that show up in real-world ReDoS guides.
const MAX_PATTERN_LENGTH = 512;
const UNSAFE_NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*]/;
function isLikelyReDoS(source: string): boolean {
  if (source.length > MAX_PATTERN_LENGTH) return true;
  return UNSAFE_NESTED_QUANTIFIER.test(source);
}

function compileUserPattern(entry: RawUserPattern, idx: number): SecretPattern {
  const { name, regex, suggestedName, priority } = entry;
  if (typeof name !== "string" || !name) {
    throw new Error(`secret-patterns.json[${idx}]: 'name' must be a non-empty string`);
  }
  if (typeof regex !== "string" || !regex) {
    throw new Error(`secret-patterns.json[${idx}]: 'regex' must be a non-empty string`);
  }
  if (typeof suggestedName !== "string" || !suggestedName) {
    throw new Error(`secret-patterns.json[${idx}]: 'suggestedName' must be a non-empty string`);
  }
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    throw new Error(`secret-patterns.json[${idx}]: 'priority' must be a finite number`);
  }
  if (isLikelyReDoS(regex)) {
    throw new Error(
      `secret-patterns.json[${idx}] '${name}': regex looks like catastrophic backtracking ` +
      `(nested quantifier or > ${MAX_PATTERN_LENGTH} chars). Rewrite without nested + / *.`,
    );
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(regex, "g");
  } catch (err) {
    throw new Error(
      `secret-patterns.json[${idx}] '${name}': invalid regex '${regex}': ${(err as Error).message}`,
    );
  }
  return { name, regex: compiled, suggestedName, priority };
}

export function loadPatterns(): SecretPattern[] {
  const home = process.env.HOME ?? "";
  const userPath = `${home}/.pi/engineering-team/secret-patterns.json`;
  const userPatterns = loadUserPatterns(userPath);
  return [...DEFAULT_PATTERNS, ...userPatterns].sort((a, b) => a.priority - b.priority);
}
