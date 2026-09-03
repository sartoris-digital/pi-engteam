import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("../../helpers/stub-pi.mjs", import.meta.url));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function runStub(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [STUB, ...args],
      { cwd, env: { PATH: process.env.PATH ?? "", ...env } },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = e === null ? 0 : typeof e.code === "number" ? e.code : 1;
        resolvePromise({ code, stdout, stderr, ms: Date.now() - started });
      },
    );
  });
}

interface Harness {
  root: string;
  workspace: string;
  runsDir: string;
  runDir: string;
  promptPath: string;
  scenarioPath: string;
  verdictFile: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

async function harness(scenario: unknown): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-stub-")));
  const workspace = join(root, "ws");
  const runsDir = join(root, "runs");
  const runDir = join(runsDir, "r1");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(runDir, "steps"), { recursive: true });
  const promptPath = join(runDir, "steps", "implement-r1.prompt.md");
  await writeFile(promptPath, "<!-- pi-sdlc-factory generated · run r1 · do not commit -->\n\nDo the thing.\n");
  const scenarioPath = join(root, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const verdictFile = join(runDir, "_verdicts", "implement");
  return {
    root,
    workspace,
    runsDir,
    runDir,
    promptPath,
    scenarioPath,
    verdictFile,
    env: {
      PI_SDLC_AGENT_MODE: "1",
      PI_SDLC_RUN_ID: "r1",
      PI_SDLC_RUNS_DIR: runsDir,
      PI_SDLC_STEP: "implement",
      PI_SDLC_WORKSPACE_DIR: workspace,
      PI_SDLC_VERDICT_FILE: verdictFile,
      PI_SDLC_STUB_SCENARIO: scenarioPath,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("stub-pi", () => {
  it("is executable so it can be used directly as piBinary", async () => {
    const mode = (await stat(STUB)).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("writes scenario files into the workspace, runDirFiles into the run dir, and the verdict file", async () => {
    const h = await harness({
      implement: {
        verdict: "PASS",
        files: { "src/new.ts": "export const x = 1;\n", "docs/nested/a.md": "# a\n" },
        runDirFiles: { "human-input/steer-1.md": "note\n" },
        commit_message: "feat: add x",
        issues: [],
      },
    });
    try {
      const r = await runStub(
        ["-p", "--no-session", "--model", "stub/model", `Read ${h.promptPath} and execute it.`],
        h.env,
        h.workspace,
      );
      expect(r.code, r.stderr).toBe(0);
      expect(await readFile(join(h.workspace, "src", "new.ts"), "utf8")).toBe("export const x = 1;\n");
      expect(await readFile(join(h.workspace, "docs", "nested", "a.md"), "utf8")).toBe("# a\n");
      expect(await readFile(join(h.runDir, "human-input", "steer-1.md"), "utf8")).toBe("note\n");
      const verdict = JSON.parse(await readFile(h.verdictFile, "utf8")) as Record<string, unknown>;
      expect(verdict).toEqual({
        step: "implement",
        verdict: "PASS",
        issues: [],
        artifacts: [],
        changedFiles: ["src/new.ts", "docs/nested/a.md"],
        commit_message: "feat: add x",
      });
      await expect(stat(`${h.verdictFile}.tmp-`)).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });

  it("accepts the @<path> prompt form and FAIL verdicts with issues", async () => {
    const h = await harness({ implement: { verdict: "FAIL", issues: ["tests red"] } });
    try {
      const r = await runStub(["-p", `@${h.promptPath}`], h.env, h.workspace);
      expect(r.code, r.stderr).toBe(0);
      const verdict = JSON.parse(await readFile(h.verdictFile, "utf8")) as { verdict: string; issues: string[]; changedFiles: string[] };
      expect(verdict.verdict).toBe("FAIL");
      expect(verdict.issues).toEqual(["tests red"]);
      expect(verdict.changedFiles).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it("noVerdict exits 0 without writing a verdict (crash/timeout simulation)", async () => {
    const h = await harness({ implement: { verdict: "PASS", noVerdict: true, files: { "a.txt": "a" } } });
    try {
      const r = await runStub(["-p", h.promptPath], h.env, h.workspace);
      expect(r.code).toBe(0);
      await expect(stat(h.verdictFile)).rejects.toThrow();
      expect(await readFile(join(h.workspace, "a.txt"), "utf8")).toBe("a");
    } finally {
      await h.cleanup();
    }
  });

  it("sleepMs delays the verdict", async () => {
    const h = await harness({ implement: { verdict: "PASS", sleepMs: 400 } });
    try {
      const r = await runStub(["-p", h.promptPath], h.env, h.workspace);
      expect(r.code).toBe(0);
      expect(r.ms).toBeGreaterThanOrEqual(380);
    } finally {
      await h.cleanup();
    }
  });

  it("fails loudly when the prompt path or the scenario entry is missing", async () => {
    const h = await harness({ plan: { verdict: "PASS" } });
    try {
      const noPrompt = await runStub(["-p", "just a message"], h.env, h.workspace);
      expect(noPrompt.code).toBe(2);
      expect(noPrompt.stderr).toContain("stub-pi: no *.prompt.md path");

      const missingFile = await runStub(["-p", join(h.root, "nope.prompt.md")], h.env, h.workspace);
      expect(missingFile.code).toBe(2);
      expect(missingFile.stderr).toContain("cannot read prompt");

      const noStep = await runStub(["-p", h.promptPath], h.env, h.workspace);
      expect(noStep.code).toBe(3);
      expect(noStep.stderr).toContain('no scenario entry for step "implement"');
      await expect(stat(h.verdictFile)).rejects.toThrow();

      const noScenario = await runStub(["-p", h.promptPath], { ...h.env, PI_SDLC_STUB_SCENARIO: "" }, h.workspace);
      expect(noScenario.code).toBe(4);
    } finally {
      await h.cleanup();
    }
  });

  it("records the invocation to PI_SDLC_STUB_LOG with only PI_SDLC_* env", async () => {
    const h = await harness({ implement: { verdict: "PASS" } });
    const log = join(h.root, "logs", "stub.jsonl");
    try {
      const r = await runStub(
        ["-p", `Read ${h.promptPath} and execute it.`],
        { ...h.env, PI_SDLC_STUB_LOG: log, SECRET_TOKEN: "should-not-appear" },
        h.workspace,
      );
      expect(r.code, r.stderr).toBe(0);
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      const rec = JSON.parse(lines[0] ?? "") as {
        argv: string[];
        cwd: string;
        promptPath: string;
        promptFirstLine: string;
        step: string;
        env: Record<string, string>;
      };
      expect(rec.argv).toEqual(["-p", `Read ${h.promptPath} and execute it.`]);
      expect(rec.cwd).toBe(h.workspace);
      expect(rec.promptPath).toBe(h.promptPath);
      expect(rec.promptFirstLine).toBe("<!-- pi-sdlc-factory generated · run r1 · do not commit -->");
      expect(rec.step).toBe("implement");
      expect(Object.keys(rec.env).every((k) => k.startsWith("PI_SDLC_"))).toBe(true);
      expect(rec.env.PI_SDLC_RUN_ID).toBe("r1");
    } finally {
      await h.cleanup();
    }
  });

  it("fails closed on a missing, typoed, or unknown verdict and writes nothing", async () => {
    const cases: { name: string; entry: Record<string, unknown>; stderr: RegExp }[] = [
      { name: "missing", entry: { files: { "a.txt": "nope" } }, stderr: /invalid verdict|missing verdict/ },
      { name: "typo key", entry: { verdct: "FAIL", files: { "a.txt": "nope" } }, stderr: /unknown scenario field "verdct"|invalid verdict|missing verdict/ },
      { name: "typo value", entry: { verdict: "PASSS", files: { "a.txt": "nope" } }, stderr: /invalid verdict/ },
      { name: "unknown field", entry: { verdict: "FAIL", extra: true }, stderr: /unknown scenario field "extra"/ },
    ];
    for (const c of cases) {
      const h = await harness({ implement: c.entry });
      try {
        const r = await runStub(["-p", h.promptPath], h.env, h.workspace);
        expect(r.code, `${c.name}: ${r.stderr}`).toBe(4);
        expect(r.stderr, c.name).toMatch(c.stderr);
        await expect(stat(join(h.workspace, "a.txt")), c.name).rejects.toThrow();
        await expect(stat(h.verdictFile), c.name).rejects.toThrow();
      } finally {
        await h.cleanup();
      }
    }
  });

  it("rejects absolute and parent-traversing files/runDirFiles and leaves outside sentinels untouched", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-stub-outside-")));
    const sentinel = join(outside, "sentinel.txt");
    try {
      await writeFile(sentinel, "SAFE\n");

      const parentEscape = await harness({
        implement: { verdict: "FAIL", files: { "../OUTSIDE_SENTINEL": "pwned\n" } },
      });
      try {
        await writeFile(join(parentEscape.root, "OUTSIDE_SENTINEL"), "SAFE\n");
        const r = await runStub(["-p", parentEscape.promptPath], parentEscape.env, parentEscape.workspace);
        expect(r.code, r.stderr).toBe(5);
        expect(r.stderr).toMatch(/escapes|parent|relative|\.\./);
        expect(await readFile(join(parentEscape.root, "OUTSIDE_SENTINEL"), "utf8")).toBe("SAFE\n");
        await expect(stat(parentEscape.verdictFile)).rejects.toThrow();
      } finally {
        await parentEscape.cleanup();
      }

      const absFiles = await harness({
        implement: { verdict: "FAIL", files: { [sentinel]: "pwned\n" } },
      });
      try {
        const r = await runStub(["-p", absFiles.promptPath], absFiles.env, absFiles.workspace);
        expect(r.code, r.stderr).toBe(5);
        expect(await readFile(sentinel, "utf8")).toBe("SAFE\n");
      } finally {
        await absFiles.cleanup();
      }

      const runDirEscape = await harness({
        implement: { verdict: "FAIL", runDirFiles: { "../../OUTSIDE_SENTINEL": "pwned\n" } },
      });
      try {
        await writeFile(join(runDirEscape.root, "OUTSIDE_SENTINEL"), "SAFE\n");
        const r = await runStub(["-p", runDirEscape.promptPath], runDirEscape.env, runDirEscape.workspace);
        expect(r.code, r.stderr).toBe(5);
        expect(await readFile(join(runDirEscape.root, "OUTSIDE_SENTINEL"), "utf8")).toBe("SAFE\n");
      } finally {
        await runDirEscape.cleanup();
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects verdict/log destinations outside the run dir or test-temp root", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-stub-dest-")));
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "SAFE\n");
    const h = await harness({ implement: { verdict: "PASS", files: { "a.txt": "x" } } });
    try {
      const badVerdict = await runStub(
        ["-p", h.promptPath],
        { ...h.env, PI_SDLC_VERDICT_FILE: sentinel },
        h.workspace,
      );
      expect(badVerdict.code, badVerdict.stderr).toBe(5);
      expect(await readFile(sentinel, "utf8")).toBe("SAFE\n");
      await expect(stat(join(h.workspace, "a.txt"))).rejects.toThrow();

      const badLog = join(outside, "stub.jsonl");
      const logEscape = await runStub(
        ["-p", h.promptPath],
        { ...h.env, PI_SDLC_STUB_LOG: badLog },
        h.workspace,
      );
      expect(logEscape.code, logEscape.stderr).toBe(5);
      await expect(stat(badLog)).rejects.toThrow();
      await expect(stat(join(h.workspace, "a.txt"))).rejects.toThrow();
    } finally {
      await h.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a workspace symlink that would escape the workspace root", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-stub-link-")));
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "SAFE\n");
    const h = await harness({
      implement: { verdict: "FAIL", files: { "escape/sentinel.txt": "pwned\n" } },
    });
    try {
      await symlink(outside, join(h.workspace, "escape"));
      const r = await runStub(["-p", h.promptPath], h.env, h.workspace);
      expect(r.code, r.stderr).toBe(5);
      expect(r.stderr).toMatch(/symlink|escapes/);
      expect(await readFile(sentinel, "utf8")).toBe("SAFE\n");
      await expect(stat(h.verdictFile)).rejects.toThrow();
    } finally {
      await h.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects an invalid run id before writing runDirFiles", async () => {
    const h = await harness({
      implement: { verdict: "FAIL", runDirFiles: { "human-input/x.md": "nope\n" } },
    });
    try {
      const r = await runStub(
        ["-p", h.promptPath],
        { ...h.env, PI_SDLC_RUN_ID: "../x" },
        h.workspace,
      );
      expect(r.code, r.stderr).toBe(4);
      expect(r.stderr).toMatch(/run id|runId|PI_SDLC_RUN_ID/i);
      await expect(stat(join(h.runDir, "human-input", "x.md"))).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });

  it("ignores -e when PI_SDLC_STUB_LOAD_EXTENSION is unset", async () => {
    const h = await harness({ implement: { verdict: "PASS", files: { "ok.txt": "ok\n" } } });
    try {
      const r = await runStub(
        ["-p", "--no-session", "-e", join(h.root, "missing-extension.ts"), h.promptPath],
        h.env,
        h.workspace,
      );
      expect(r.code, r.stderr).toBe(0);
      expect(await readFile(join(h.workspace, "ok.txt"), "utf8")).toBe("ok\n");
      expect(r.stderr).not.toMatch(/cannot load extension|guard/);
    } finally {
      await h.cleanup();
    }
  });

  it("does not load the extension when PI_SDLC_STUB_LOAD_EXTENSION=1 but argv has no -e", async () => {
    const h = await harness({ implement: { verdict: "PASS" } });
    const log = join(h.runDir, "stub.jsonl");
    try {
      const r = await runStub(
        ["-p", h.promptPath],
        { ...h.env, PI_SDLC_STUB_LOAD_EXTENSION: "1", PI_SDLC_STUB_LOG: log },
        h.workspace,
      );
      expect(r.code, r.stderr).toBe(0);
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).not.toHaveProperty("kind", "guard");
    } finally {
      await h.cleanup();
    }
  });
});
