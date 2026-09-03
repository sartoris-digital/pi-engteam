import { createHash } from "node:crypto";

export interface ToolRunRequest {
  toolPy: string;
  lockFile?: string;
  workspace: string;
  input: unknown;
  class: "stage-tool" | "task-tool";
  dryRun?: boolean;
  generatedDir?: string;
  envNames?: string[];
  secrets?: Record<string, string>;
  networkAllow?: string[];
  pythonhashseed?: "0";
}

export interface ToolRunJson {
  ok: boolean;
  code: number;
  patchSha256?: string;
  changedFiles?: string[];
  postconditions?: string[];
}

export interface ToolRunResult {
  exitCode: number;
  stdout: string;
  stderrTail: string;
  durationMs: number;
  json?: ToolRunJson;
}

export interface ToolRunner {
  run(req: ToolRunRequest): Promise<ToolRunResult>;
}

export const GOLDEN_BUMP_INPUT = { pkg: "fixture-app", version: "1.1.0" } as const;

const GOLDEN_PATCH = [
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -1,6 +1,6 @@",
  " {",
  '   "name": "fixture-app",',
  '-  "version": "0.1.0",',
  '+  "version": "1.1.0",',
  '   "private": true,',
  "",
].join("\n");

function keyOf(workspace: string, input: unknown): string {
  return `${workspace}\n${JSON.stringify(input)}`;
}

function scrub(text: string, secrets?: Record<string, string>): string {
  if (secrets === undefined) return text;
  let out = text;
  for (const value of Object.values(secrets)) {
    if (value.length === 0) continue;
    out = out.split(value).join("secret:REDACTED");
  }
  return out;
}

function parseJsonLine(stdout: string): ToolRunJson | undefined {
  const line = stdout.trim().split("\n")[0];
  if (line === undefined || line.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.ok !== "boolean" || typeof rec.code !== "number") return undefined;
    const json: ToolRunJson = { ok: rec.ok, code: rec.code };
    if (typeof rec.patchSha256 === "string") json.patchSha256 = rec.patchSha256;
    if (Array.isArray(rec.changedFiles)) json.changedFiles = rec.changedFiles.filter((x): x is string => typeof x === "string");
    if (Array.isArray(rec.postconditions)) {
      json.postconditions = rec.postconditions.filter((x): x is string => typeof x === "string");
    }
    return json;
  } catch {
    return undefined;
  }
}

function goldenResult(): ToolRunResult {
  const patchSha256 = createHash("sha256").update(GOLDEN_PATCH).digest("hex");
  const json: ToolRunJson = {
    ok: true,
    code: 0,
    patchSha256,
    changedFiles: ["package.json"],
    postconditions: ["checks:lint"],
    patch: GOLDEN_PATCH,
  } as ToolRunJson & { patch: string };
  const stdout = `${JSON.stringify({ ...json, patch: GOLDEN_PATCH })}\n`;
  return { exitCode: 0, stdout, stderrTail: "", durationMs: 0, json: parseJsonLine(stdout) };
}

export class FakeToolRunner implements ToolRunner {
  private readonly results = new Map<string, ToolRunResult>();

  register(workspace: string, input: unknown, result: ToolRunResult): void {
    this.results.set(keyOf(workspace, input), result);
  }

  async run(req: ToolRunRequest): Promise<ToolRunResult> {
    const mapped = this.results.get(keyOf(req.workspace, req.input));
    const raw = mapped ?? (JSON.stringify(req.input) === JSON.stringify(GOLDEN_BUMP_INPUT) ? goldenResult() : undefined);
    if (raw === undefined) {
      const json = { ok: false, code: 3 };
      return {
        exitCode: 3,
        stdout: `${JSON.stringify(json)}\n`,
        stderrTail: "FakeToolRunner: no mapped result",
        durationMs: 0,
        json,
      };
    }
    const stdout = scrub(raw.stdout, req.secrets);
    const stderrTail = scrub(raw.stderrTail, req.secrets);
    return {
      exitCode: raw.exitCode,
      stdout,
      stderrTail,
      durationMs: raw.durationMs,
      json: parseJsonLine(stdout) ?? raw.json,
    };
  }
}

/** Production runner shells out to uv; unit tests inject FakeToolRunner instead. */
export class UvToolRunner implements ToolRunner {
  async run(_req: ToolRunRequest): Promise<ToolRunResult> {
    throw new Error("UvToolRunner is not used in unit tests; inject FakeToolRunner");
  }
}
