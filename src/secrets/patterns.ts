// src/secrets/patterns.ts
import { readFileSync } from "node:fs";

export type SecretPattern = {
  name: string;
  regex: RegExp;
  suggestedName: string;
  priority: number;
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
    regex: /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi,
    suggestedName: "AWS_SECRET_ACCESS_KEY",
    priority: 8,
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

  return parsed.map((entry, idx) => compileUserPattern(entry as RawUserPattern, idx));
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
