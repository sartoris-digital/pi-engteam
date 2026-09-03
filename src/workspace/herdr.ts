import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HerdrCli {
  status(): Promise<{ running: boolean; raw: string }>;
  worktreeCreate(opts: { cwd: string; branch: string; base: string; label: string }): Promise<{ workspaceId: string; path: string }>;
  worktreeRemove(opts: { workspaceId: string; force?: boolean }): Promise<void>;
  worktreeList(cwd: string): Promise<Array<{ workspaceId: string; path: string }>>;
  paneSplit(opts: { workspaceId: string; env: Record<string, string> }): Promise<{ paneId: string }>;
  agentStart(opts: { name: string; paneId: string; extraArgs: string[] }): Promise<void>;
  agentPrompt(opts: { name: string; text: string; timeoutMs: number }): Promise<void>;
  agentSendKeys(opts: { name: string; keys: string }): Promise<void>;
  paneClose(paneId: string): Promise<void>;
  paneProcessInfo(paneId: string): Promise<{ pid: number | null }>;
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  return JSON.parse(trimmed) as unknown;
}

/** Production herdr CLI. Unit tests inject HerdrCli and never call this. */
export function realHerdrCli(bin = "herdr"): HerdrCli {
  const run = async (args: string[], cwd?: string): Promise<string> => {
    const { stdout } = await execFileAsync(bin, args, { cwd, encoding: "utf8", timeout: 30_000 });
    return stdout;
  };
  return {
    async status() {
      try {
        const { stdout } = await execFileAsync(bin, ["status"], { encoding: "utf8", timeout: 3_000 });
        return { running: !/not running|inactive|stopped/i.test(stdout), raw: stdout };
      } catch (err) {
        return { running: false, raw: err instanceof Error ? err.message : String(err) };
      }
    },
    async worktreeCreate(opts) {
      const raw = await run(["worktree", "create", "--branch", opts.branch, "--base", opts.base, "--label", opts.label], opts.cwd);
      const parsed = parseJson(raw) as { workspaceId?: string; id?: string; path?: string } | null;
      const workspaceId = parsed?.workspaceId ?? parsed?.id;
      const path = parsed?.path;
      if (typeof workspaceId !== "string" || typeof path !== "string") {
        throw new Error(`herdr worktree create: missing workspaceId/path in ${raw}`);
      }
      return { workspaceId, path };
    },
    async worktreeRemove(opts) {
      await run(["worktree", "remove", opts.workspaceId, ...(opts.force === true ? ["--force"] : [])]);
    },
    async worktreeList(cwd) {
      const raw = await run(["worktree", "list"], cwd);
      const parsed = parseJson(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((row) => {
        if (row === null || typeof row !== "object") return [];
        const rec = row as { workspaceId?: string; id?: string; path?: string };
        const workspaceId = rec.workspaceId ?? rec.id;
        if (typeof workspaceId !== "string" || typeof rec.path !== "string") return [];
        return [{ workspaceId, path: rec.path }];
      });
    },
    async paneSplit(opts) {
      const raw = await run(["pane", "split", opts.workspaceId]);
      const parsed = parseJson(raw) as { paneId?: string; id?: string } | null;
      const paneId = parsed?.paneId ?? parsed?.id;
      if (typeof paneId !== "string") throw new Error(`herdr pane split: missing paneId in ${raw}`);
      return { paneId };
    },
    async agentStart(opts) {
      await run(["agent", "start", opts.name, "--pane", opts.paneId, ...opts.extraArgs]);
    },
    async agentPrompt(opts) {
      await run(["agent", "prompt", opts.name, opts.text]);
    },
    async agentSendKeys(opts) {
      await run(["agent", "send-keys", opts.name, opts.keys]);
    },
    async paneClose(paneId) {
      await run(["pane", "close", paneId]);
    },
    async paneProcessInfo(paneId) {
      const raw = await run(["pane", "process-info", paneId]);
      const parsed = parseJson(raw) as { pid?: number | null } | null;
      return { pid: typeof parsed?.pid === "number" ? parsed.pid : null };
    },
  };
}

export async function herdrRunning(cli?: HerdrCli): Promise<boolean> {
  try {
    const status = await (cli ?? realHerdrCli()).status();
    return status.running;
  } catch {
    return false;
  }
}
