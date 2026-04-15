// src/commands/issue-tracker.ts
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type TrackerType = "github" | "ado" | "jira" | "unknown";

export interface TrackerResolution {
  tracker: TrackerType;
  ticketId: string;
}

const GITHUB_URL = /github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/;
const ADO_URL = /dev\.azure\.com\/[^/]+\/[^/]+\/_workitems\/edit\/(\d+)|visualstudio\.com\/[^/]+\/_workitems\/edit\/(\d+)/;
const JIRA_URL = /[a-z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/i;
const JIRA_BARE = /^[A-Z][A-Z0-9]+-\d+$/;

export function parseUrl(input: string): TrackerResolution | null {
  let m: RegExpMatchArray | null;
  if ((m = input.match(GITHUB_URL))) return { tracker: "github", ticketId: m[1] };
  if ((m = input.match(ADO_URL))) return { tracker: "ado", ticketId: m[1] ?? m[2] };
  if ((m = input.match(JIRA_URL))) return { tracker: "jira", ticketId: m[1] };
  return null;
}

function extractBareId(input: string, tracker: TrackerType): string {
  if (tracker === "github") return input.replace(/^#/, "");
  if (tracker === "ado") return input.replace(/^ADO-/i, "");
  return input;
}

export async function readTrackerConfig(): Promise<TrackerType | null> {
  try {
    const configPath = join(homedir(), ".pi", "engteam", "issue-tracker.json");
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { default?: string };
    const t = parsed.default;
    if (t === "github" || t === "ado" || t === "jira") return t;
    return null;
  } catch {
    return null;
  }
}

export async function detectFromGitRemote(): Promise<TrackerType | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "-v"]);
    if (stdout.includes("github.com")) return "github";
    if (stdout.includes("dev.azure.com") || stdout.includes("visualstudio.com")) return "ado";
    return null;
  } catch {
    return null;
  }
}

export async function detectTracker(
  input: string,
  explicitTracker?: string,
): Promise<TrackerResolution> {
  // 1. URL pattern (most reliable)
  const fromUrl = parseUrl(input);
  if (fromUrl) return fromUrl;

  // 2. Explicit --tracker flag
  if (explicitTracker === "github" || explicitTracker === "ado" || explicitTracker === "jira") {
    return { tracker: explicitTracker, ticketId: extractBareId(input, explicitTracker) };
  }

  // 3. Jira bare ID pattern (unambiguous format)
  if (JIRA_BARE.test(input)) {
    return { tracker: "jira", ticketId: input };
  }

  // 4. Config file
  const fromConfig = await readTrackerConfig();
  if (fromConfig) return { tracker: fromConfig, ticketId: extractBareId(input, fromConfig) };

  // 5. Git remote URL
  const fromGit = await detectFromGitRemote();
  if (fromGit) return { tracker: fromGit, ticketId: extractBareId(input, fromGit) };

  // 6. Unknown — agent will read AGENTS.md / CLAUDE.md at runtime
  return { tracker: "unknown", ticketId: input };
}
