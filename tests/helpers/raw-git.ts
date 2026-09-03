// tests/helpers/raw-git.ts — plain git for arranging fixture state in tests.
// This is deliberately NOT the hook-free host wrapper under test.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const RAW_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  LC_ALL: "C",
};

/** Runs git in cwd and returns trimmed stdout; rejects on non-zero exit. */
export async function rawGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: { ...process.env, ...RAW_GIT_ENV },
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.trim();
}
