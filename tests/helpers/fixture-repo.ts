import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITEST_MJS = join(ROOT, "node_modules", "vitest", "vitest.mjs");

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface FixtureRepo {
  /** Temp directory holding `repo/` and `remote.git/`. */
  root: string;
  /** Working checkout on `main`, origin = `bare`. */
  repo: string;
  /** Bare remote. */
  bare: string;
  defaultBranch: "main";
  /** Sha of the single initial commit (== origin/main). */
  baseSha: string;
  git: (args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;
  cleanup: () => Promise<void>;
}

export interface FixtureCheck {
  name: string;
  argv: string[];
  reporter: "junit";
  junitPath: string;
  timeoutSeconds: number;
}

export interface FixtureFactoryJson {
  schemaVersion: 1;
  checks: FixtureCheck[];
  testDir: string;
  testPattern: string;
  testInfra: string[];
}

/** Identity + no-gpg + no-hooks flags so fixture git never depends on the operator's config. */
export const FIXTURE_GIT_ARGS: readonly string[] = [
  "-c", "user.name=Fixture",
  "-c", "user.email=fixture@example.com",
  "-c", "commit.gpgsign=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "init.defaultBranch=main",
];

/** Copy of `base` without the parent vitest/vite environment, plus quiet git settings. */
export function fixtureEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/^(VITEST|VITE_)/.test(key) || key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  return env;
}

function execIn(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      { cwd, env: fixtureEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr, code: 0 });
          return;
        }
        const e = error as NodeJS.ErrnoException & { code?: number | string; signal?: string };
        const code = typeof e.code === "number" ? e.code : 1;
        const detail = typeof e.code === "string" ? `${e.code}: ${e.message}\n` : e.signal ? `signal ${e.signal}\n` : "";
        resolvePromise({ stdout, stderr: detail + stderr, code });
      },
    );
  });
}

export function gitIn(cwd: string, args: string[]): Promise<ExecResult> {
  return execIn("git", [...FIXTURE_GIT_ARGS, ...args], cwd, 60_000);
}

function mustOk(r: ExecResult, what: string): ExecResult {
  if (r.code !== 0) throw new Error(`fixture git ${what} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r;
}

export function fixtureFactoryJson(): FixtureFactoryJson {
  return {
    schemaVersion: 1,
    checks: [
      {
        name: "test",
        argv: ["node", VITEST_MJS, "run", "--globals", "--reporter=junit", "--outputFile=reports/junit.xml"],
        reporter: "junit",
        junitPath: "reports/junit.xml",
        timeoutSeconds: 120,
      },
    ],
    testDir: "tests",
    testPattern: "**/*.test.ts",
    testInfra: [],
  };
}

export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "package.json":
    JSON.stringify(
      { name: "fixture-app", version: "0.1.0", private: true, type: "module", scripts: { test: "vitest run" } },
      null,
      2,
    ) + "\n",
  ".gitignore": "node_modules/\nreports/\n.pi/*.local.*\n",
  "src/index.ts": [
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function greet(name: string): string {",
    '  return "hello, " + name;',
    "}",
    "",
  ].join("\n"),
  "tests/smoke.test.ts": [
    "// Run by .pi/factory.json checks with `vitest run --globals`, so no vitest import is needed",
    "// and the fixture has no node_modules of its own.",
    'import { add, greet } from "../src/index.js";',
    "",
    "declare const test: (name: string, fn: () => void) => void;",
    "declare const expect: (actual: unknown) => { toBe(expected: unknown): void };",
    "",
    'test("smoke: add", () => {',
    "  expect(add(1, 2)).toBe(3);",
    "});",
    "",
    'test("smoke: greet", () => {',
    '  expect(greet("factory")).toBe("hello, factory");',
    "});",
    "",
  ].join("\n"),
  "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- Initial fixture package.\n",
};

export async function makeFixtureRepo(): Promise<FixtureRepo> {
  await stat(VITEST_MJS).catch(() => {
    throw new Error(`vitest not installed at ${VITEST_MJS}; run pnpm install`);
  });
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-fixture-")));
  const repo = join(root, "repo");
  const bare = join(root, "remote.git");
  await mkdir(repo, { recursive: true });
  const git = (args: string[], opts?: { cwd?: string }) => gitIn(opts?.cwd ?? repo, args);

  mustOk(await git(["init", "-q", "-b", "main"]), "init");
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(repo, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await mkdir(join(repo, ".pi"), { recursive: true });
  await writeFile(join(repo, ".pi", "factory.json"), JSON.stringify(fixtureFactoryJson(), null, 2) + "\n", "utf8");
  mustOk(await git(["add", "-A"]), "add");
  mustOk(await git(["commit", "-q", "-m", "chore: initial fixture"]), "commit");
  const baseSha = mustOk(await git(["rev-parse", "HEAD"]), "rev-parse").stdout.trim();

  mustOk(await gitIn(root, ["init", "-q", "--bare", "-b", "main", bare]), "init --bare");
  mustOk(await git(["remote", "add", "origin", bare]), "remote add");
  mustOk(await git(["push", "-q", "-u", "origin", "main"]), "push");
  mustOk(await git(["remote", "set-head", "origin", "main"]), "remote set-head");

  let cleaned = false;
  return {
    root,
    repo,
    bare,
    defaultBranch: "main",
    baseSha,
    git,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Run one `checks[]` entry the way the host will: execFile, no shell, scrubbed env. */
export async function runFixtureCheck(
  cwd: string,
  check: { argv: string[]; timeoutSeconds: number },
): Promise<ExecResult> {
  const [cmd, ...args] = check.argv;
  if (cmd === undefined) throw new Error("check.argv is empty");
  return execIn(cmd, args, cwd, check.timeoutSeconds * 1000);
}
