import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hostGit } from "../git/host-git.js";
import type { HostCli } from "../trackers/host-cli.js";

export { probeSandbox } from "../runtime/sandbox.js";

export interface CliProbe {
  available: boolean;
  reason?: string;
}

export interface GitProbe {
  ok: boolean;
  repoRoot: string;
  remotes: { name: string; url: string }[];
}
export interface DefaultBranchProbe {
  branch: string | null;
  source: "origin-head" | "head" | "none";
}
export interface PackageManagerProbe {
  manager: "pnpm" | "npm" | "yarn" | "bun" | "none";
  lockfile: string | null;
}
export interface ChecksProbe {
  checks: { name: string; argv: string[]; reporter: "junit" | "none"; junitPath?: string }[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function probeGit(repo: string): Promise<GitProbe> {
  const gitDir = join(repo, ".git");
  if (!(await exists(gitDir))) return { ok: false, repoRoot: repo, remotes: [] };
  const result = await hostGit(["remote", "-v"], { cwd: repo });
  const remotes: GitProbe["remotes"] = [];
  const seen = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line.trim());
    if (match && !seen.has(match[1]!)) {
      seen.add(match[1]!);
      remotes.push({ name: match[1]!, url: match[2]! });
    }
  }
  return { ok: true, repoRoot: repo, remotes };
}

export async function probeDefaultBranch(repo: string): Promise<DefaultBranchProbe> {
  const origin = await hostGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
  if (origin.code === 0) {
    const branch = origin.stdout.trim().replace(/^origin\//, "");
    if (branch.length > 0) return { branch, source: "origin-head" };
  }
  const head = await hostGit(["symbolic-ref", "--short", "HEAD"], { cwd: repo });
  if (head.code === 0) {
    const branch = head.stdout.trim();
    if (branch.length > 0) return { branch, source: "head" };
  }
  return { branch: null, source: "none" };
}

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
] as const;

export async function probePackageManager(repo: string): Promise<PackageManagerProbe> {
  for (const [lockfile, manager] of LOCKFILES) {
    if (await exists(join(repo, lockfile))) return { manager, lockfile };
  }
  return { manager: "none", lockfile: null };
}

async function probeCli(cli: HostCli, argv: readonly string[]): Promise<CliProbe> {
  try {
    const result = await cli.exec(argv);
    if (result.code === 0) return { available: true };
    const reason = result.stderr.trim() || result.stdout.trim() || `${argv.join(" ")} exited ${result.code}`;
    return { available: false, reason };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Host-only `az account show`. Never throws. */
export function probeAz(cli: HostCli): Promise<CliProbe> {
  return probeCli(cli, ["az", "account", "show"]);
}

/** Host-only `jira me`. Never throws. */
export function probeJira(cli: HostCli): Promise<CliProbe> {
  return probeCli(cli, ["jira", "me"]);
}

export async function probeChecks(repo: string): Promise<ChecksProbe> {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return { checks: [] };
  }
  const blob = JSON.stringify({
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    test: pkg.scripts?.test ?? "",
  });
  if (!/\bvitest\b/.test(blob)) return { checks: [] };
  return {
    checks: [
      {
        name: "vitest",
        argv: ["pnpm", "exec", "vitest", "run", "--reporter=junit", "--outputFile=reports/junit.xml"],
        reporter: "junit",
        junitPath: "reports/junit.xml",
      },
    ],
  };
}
