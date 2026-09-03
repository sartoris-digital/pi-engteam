import { spawn } from "node:child_process";

export interface HostCliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface HostCliExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface HostCli {
  exec(argv: readonly string[], opts?: HostCliExecOptions): Promise<HostCliResult>;
}

export class HostCliError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly argv: readonly string[];
  constructor(argv: readonly string[], result: HostCliResult) {
    super(`${argv[0] ?? "cli"} ${argv.slice(1).join(" ")} exited ${result.code}`);
    this.name = "HostCliError";
    this.code = result.code;
    this.stderr = result.stderr;
    this.argv = argv;
  }
}

/** Production PATH exec. Host-only; workers never call this. */
export function createPathCli(env?: NodeJS.ProcessEnv): HostCli {
  const baseEnv = env ?? process.env;
  return {
    exec(argv, opts) {
      const bin = argv[0];
      if (bin === undefined || bin.length === 0) {
        return Promise.resolve({ stdout: "", stderr: "host-cli: empty argv", code: 2 });
      }
      const args = argv.slice(1).map(String);
      const childEnv = { ...baseEnv, ...(opts?.env ?? {}) };
      return new Promise((resolve) => {
        const child = spawn(bin, args, {
          cwd: opts?.cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
          const code = err.code === "ENOENT" ? 127 : 1;
          resolve({ stdout, stderr: stderr || err.message, code });
        });
        child.on("close", (code, signal) => {
          resolve({ stdout, stderr, code: code ?? (signal ? 1 : 0) });
        });
        if (opts?.input !== undefined) child.stdin.write(opts.input);
        child.stdin.end();
      });
    },
  };
}

export function createFakeCli(
  handler: (argv: readonly string[]) => HostCliResult | Promise<HostCliResult>,
): HostCli {
  return {
    exec: (argv) => Promise.resolve(handler(argv)),
  };
}
