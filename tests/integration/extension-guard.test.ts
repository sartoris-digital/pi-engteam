import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXTENSION_ENTRY } from "../../src/runtime/headless.js";

const STUB = fileURLToPath(new URL("../helpers/stub-pi.mjs", import.meta.url));

const POLICY_TEXT = [
  "schemaVersion: 1",
  "agents:",
  "  implementer:",
  '    upsert: ["src/**"]',
  "    bash: full",
  "",
].join("\n");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runStub(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [STUB, ...args],
      { cwd, env: { PATH: process.env.PATH ?? "", HOME: env.HOME ?? tmpdir(), ...env } },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = e === null ? 0 : typeof e.code === "number" ? e.code : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

async function workerFixture(): Promise<{
  root: string;
  workspace: string;
  promptPath: string;
  env: Record<string, string>;
  logPath: string;
  verdictFile: string;
  cleanup: () => Promise<void>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-ext-guard-")));
  const workspace = join(root, "ws");
  const runsDir = join(root, "runs");
  const runDir = join(runsDir, "run-g1");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(runDir, "steps"), { recursive: true });
  await mkdir(join(runsDir, "_factory", "policy"), { recursive: true });
  const policyFile = join(runsDir, "_factory", "policy", "snapshot.yaml");
  await writeFile(policyFile, POLICY_TEXT);
  const policySha = createHash("sha256").update(POLICY_TEXT).digest("hex");
  const promptPath = join(runDir, "steps", "implement-r1.prompt.md");
  await writeFile(promptPath, "<!-- pi-sdlc-factory generated · run run-g1 · do not commit -->\n\nImplement.\n");
  const scenarioPath = join(root, "scenario.json");
  await writeFile(
    scenarioPath,
    JSON.stringify({ implement: { verdict: "PASS", files: { "src/added.ts": "export const n = 1;\n" } } }),
  );
  const verdictFile = join(runDir, "_verdicts", "implement-r1.json");
  const logPath = join(runDir, "stub.jsonl");
  return {
    root,
    workspace,
    promptPath,
    verdictFile,
    logPath,
    env: {
      HOME: root,
      PI_SDLC_HOME: root,
      PI_SDLC_AGENT_MODE: "1",
      PI_SDLC_RUN_ID: "run-g1",
      PI_SDLC_RUNS_DIR: runsDir,
      PI_SDLC_STEP: "implement",
      PI_SDLC_AGENT: "implementer",
      PI_SDLC_WORKSPACE_DIR: workspace,
      PI_SDLC_PROJECT_ROOT: join(root, "main"),
      PI_SDLC_POLICY_FILE: policyFile,
      PI_SDLC_POLICY_SHA: policySha,
      PI_SDLC_EXTRA_UPSERT: "[]",
      PI_SDLC_DENY_UPSERT: "[]",
      PI_SDLC_NONCE: "nonce-g1",
      PI_SDLC_TOOLS: "read,write,edit,bash",
      PI_SDLC_VERDICT_FILE: verdictFile,
      PI_SDLC_STUB_SCENARIO: scenarioPath,
      PI_SDLC_STUB_LOG: logPath,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function argv(promptPath: string): string[] {
  return ["-p", "--no-session", "-e", DEFAULT_EXTENSION_ENTRY, `Read ${promptPath} and execute it.`];
}

function logRecords(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("stub-pi -e loads Layers A–D", () => {
  it("ignores -e when PI_SDLC_STUB_LOAD_EXTENSION is unset so the chore-lane path stays scenario-only", async () => {
    const f = await workerFixture();
    try {
      const r = await runStub(argv(f.promptPath), f.env, f.workspace);
      expect(r.code, r.stderr).toBe(0);
      expect(await readFile(join(f.workspace, "src", "added.ts"), "utf8")).toBe("export const n = 1;\n");
      const records = logRecords(await readFile(f.logPath, "utf8"));
      expect(records.some((rec) => rec.kind === "guard")).toBe(false);
      expect(r.stderr).not.toMatch(/git push is never allowed/);
    } finally {
      await f.cleanup();
    }
  });

  it("installs the worker guard via -e and terminates a synthetic git push", async () => {
    const f = await workerFixture();
    try {
      const r = await runStub(argv(f.promptPath), { ...f.env, PI_SDLC_STUB_LOAD_EXTENSION: "1" }, f.workspace);
      expect(r.code, r.stderr).toBe(0);
      expect(await readFile(join(f.workspace, "src", "added.ts"), "utf8")).toBe("export const n = 1;\n");
      const verdict = JSON.parse(await readFile(f.verdictFile, "utf8")) as { verdict: string };
      expect(verdict.verdict).toBe("PASS");

      const records = logRecords(await readFile(f.logPath, "utf8"));
      const guard = records.find((rec) => rec.kind === "guard") as
        | { result?: { block?: boolean; terminate?: boolean; reason?: string }; toolName?: string; command?: string }
        | undefined;
      expect(guard, `stderr:\n${r.stderr}\nlog:\n${await readFile(f.logPath, "utf8")}`).toBeDefined();
      expect(guard?.toolName).toBe("bash");
      expect(guard?.command).toBe("git push origin HEAD");
      expect(guard?.result?.block).toBe(true);
      expect(guard?.result?.terminate).toBe(true);
      expect(guard?.result?.reason).toMatch(/^\[Layer A\].*git push is never allowed/);
    } finally {
      await f.cleanup();
    }
  });
});
