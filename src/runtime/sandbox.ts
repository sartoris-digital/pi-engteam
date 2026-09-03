import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { generatedMarker } from "./marker.js";
import type { WorkerRequest } from "./types.js";

const execFileAsync = promisify(execFile);

export type SandboxProvider = "sandbox-exec" | "bwrap";

export interface SandboxProfile {
  workspaceDir: string;
  runDir: string;
  allowWrite: string[];
  /** Absolute paths; an entry ending in "*" is a filename-prefix glob (e.g. ~/.config/jira*). */
  denyRead: string[];
  denyUnixSockets: string[];
  network: "allow" | "deny";
  /** Host allowlist for v1.5/v2 workers; unused by the v1 wrap (no CONNECT proxy). */
  networkAllow?: string[];
}

export interface SandboxProbe {
  available: boolean;
  provider: SandboxProvider | null;
  detail: string;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** Spec §5.8 credential stores plus `.ssh` and OS keyring. Absolute entries (e.g. `/Library/Keychains`) are used as-is. */
export const PROTECTED_READ_DENY = [
  ".config/gh",
  ".git-credentials",
  ".npmrc",
  ".azure",
  ".docker",
  ".config/jira*",
  ".config/herdr",
  ".ssh",
  "Library/Keychains",
  ".local/share/keyrings",
  "/Library/Keychains",
] as const;
export const HERDR_SOCKET = ".config/herdr/herdr.sock";

/** Absolute form of a profile path. Do not realpath: macOS `/var` → `/private/var` would diverge from the paths the tests (and worker request) supply. */
function canonical(p: string): string {
  return resolve(p);
}

function sbString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sbRegexPrefix(p: string): string {
  return `#"^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`;
}

function isGlob(entry: string): boolean {
  return entry.endsWith("*");
}

/** Expand prefix globs against the file system; drop entries that do not exist. */
function expandDenyEntries(entries: string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (isGlob(entry)) {
      const prefix = basename(entry.slice(0, -1));
      const dir = dirname(entry);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (name.startsWith(prefix)) out.push(join(dir, name));
      }
    } else if (existsSync(entry)) {
      out.push(entry);
    }
  }
  return out;
}

export function renderSeatbeltProfile(profile: SandboxProfile, runId: string): string {
  const lines: string[] = [
    `;; ${generatedMarker(runId)}`,
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr"))',
  ];
  for (const p of profile.allowWrite) {
    lines.push(`(allow file-write* (subpath ${sbString(canonical(p))}))`);
  }
  for (const p of profile.denyRead) {
    if (isGlob(p)) lines.push(`(deny file-read* (regex ${sbRegexPrefix(resolve(p.slice(0, -1)))}))`);
    else lines.push(`(deny file-read* (subpath ${sbString(canonical(p))}))`);
  }
  for (const s of profile.denyUnixSockets) {
    lines.push(`(deny network-outbound (literal ${sbString(canonical(s))}))`);
  }
  if (profile.network === "deny") lines.push("(deny network*)");
  if (profile.networkAllow !== undefined && profile.networkAllow.length > 0) {
    lines.push(`;; networkAllow ${profile.networkAllow.join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderBwrapArgs(profile: SandboxProfile): string[] {
  const args = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
  for (const p of profile.allowWrite) {
    const c = canonical(p);
    if (existsSync(c)) args.push("--bind", c, c);
  }
  for (const p of expandDenyEntries(profile.denyRead)) {
    if (statSync(p).isDirectory()) args.push("--tmpfs", p);
    else args.push("--ro-bind", "/dev/null", p);
  }
  for (const s of profile.denyUnixSockets) {
    if (existsSync(s)) args.push("--ro-bind", "/dev/null", s);
  }
  if (profile.network === "deny") args.push("--unshare-net");
  args.push("--");
  return args;
}

export interface WrapArgvOptions {
  platform?: NodeJS.Platform;
}

/** Wraps a factory Pi argv in the platform sandbox; writes the profile next to the run so the launcher shim can reuse it. */
export function wrapArgv(argv: string[], profile: SandboxProfile, opts: WrapArgvOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const runId = basename(profile.runDir);
  mkdirSync(profile.runDir, { recursive: true });
  if (platform === "darwin") {
    const profilePath = join(profile.runDir, "sandbox.sb");
    writeFileSync(profilePath, renderSeatbeltProfile(profile, runId), { mode: 0o600 });
    return ["sandbox-exec", "-f", profilePath, ...argv];
  }
  if (platform === "linux") {
    const args = renderBwrapArgs(profile);
    writeFileSync(join(profile.runDir, "sandbox.bwrap"), `${[generatedMarker(runId), ...args].join("\n")}\n`, { mode: 0o600 });
    return [...args, ...argv];
  }
  throw new SandboxUnavailableError(`no sandbox provider for platform ${platform}`);
}

export interface ProbeSandboxOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  tmpRoot?: string;
}

export async function probeSandbox(opts: ProbeSandboxOptions = {}): Promise<SandboxProbe> {
  const platform = opts.platform ?? process.platform;
  const provider: SandboxProvider | null = platform === "darwin" ? "sandbox-exec" : platform === "linux" ? "bwrap" : null;
  if (provider === null) {
    return { available: false, provider: null, detail: `no sandbox provider for platform ${platform}` };
  }
  const root = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "pi-sdlc-probe-"));
  try {
    const runDir = join(root, "runs", "probe");
    const workspaceDir = join(root, "ws");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    const profile: SandboxProfile = { workspaceDir, runDir, allowWrite: [workspaceDir, runDir], denyRead: [], denyUnixSockets: [], network: "allow" };
    const trueBin = existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";
    const [cmd, ...rest] = wrapArgv([trueBin], profile, { platform });
    if (cmd === undefined) throw new Error("wrapArgv returned an empty argv");
    await execFileAsync(cmd, rest, { env: opts.env ?? process.env, timeout: 10_000 });
    return { available: true, provider, detail: `${provider} ran ${trueBin} under a generated profile` };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = e.code === "ENOENT" ? `${provider} not found on PATH` : `${provider} failed: ${(e.stderr ?? e.message).trim()}`;
    return { available: false, provider, detail };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Reads the `gitdir:` pointer of a linked worktree so its private git dir can be write-allowed. */
export function worktreeGitDir(workspaceDir: string): string | null {
  const dotGit = join(workspaceDir, ".git");
  try {
    if (!statSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    const target = match?.[1];
    return target ? resolve(workspaceDir, target) : null;
  } catch {
    return null;
  }
}

export interface ProfileForRequestOptions {
  home?: string;
  tmpDir?: string;
}

export function profileForRequest(req: WorkerRequest, opts: ProfileForRequestOptions = {}): SandboxProfile {
  const home = opts.home ?? homedir();
  const allowWrite = [req.cwd, req.runDir, opts.tmpDir ?? tmpdir()];
  const gitDir = worktreeGitDir(req.cwd);
  if (gitDir !== null) allowWrite.push(gitDir);
  return {
    workspaceDir: req.cwd,
    runDir: req.runDir,
    allowWrite,
    denyRead: PROTECTED_READ_DENY.map((rel) => (rel.startsWith("/") ? rel : join(home, rel))),
    denyUnixSockets: [join(home, HERDR_SOCKET)],
    network: "allow",
  };
}
