import { execFile } from "node:child_process";

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
  headers?: Record<string, string>;
}

export type GhExec = (args: string[], opts?: { repo?: string }) => Promise<GhResult>;

export class GhError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = "GhError";
    this.code = code;
    this.stderr = stderr;
  }
}

export function ensureRepoFlag(args: readonly string[], repo: string): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "--repo" && typeof out[i + 1] === "string") return out;
  }
  out.push("--repo", repo);
  return out;
}

/** Production `gh` exec. Unit tests must not call this against the network. */
export function realGhExec(bin: string = "gh"): GhExec {
  return (args, opts) => {
    const argv = opts?.repo ? ensureRepoFlag(args, opts.repo) : [...args];
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        argv,
        { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) return resolve({ stdout, stderr, code: 0 });
          const e = err as NodeJS.ErrnoException;
          if (typeof e.code === "string") return reject(e);
          resolve({ stdout, stderr, code: typeof e.code === "number" ? e.code : 1 });
        },
      );
    });
  };
}
