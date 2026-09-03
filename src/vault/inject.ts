import { spawn } from "node:child_process";
import { basename } from "node:path";
import { makeScrubber } from "./scrubber.js";
import { vaultNameOf } from "./bind.js";
import type { Vault } from "./vault.js";
import { WORKER_ENV_PASSTHROUGH } from "../runtime/env.js";

const DUMP_BINS = new Set(["printenv", "env", "set"]);
const OUTPUT_CAP = 64 * 1024;

export interface RunWithSecretOpts {
  vault: Vault;
  name: string;
  command: string;
  argv: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function wouldDumpEnv(command: string, argv: string[]): boolean {
  const bin = basename(command).replace(/\.exe$/i, "");
  if (DUMP_BINS.has(bin)) return true;
  if (bin === "pi") return true;
  const joined = [command, ...argv].join(" ");
  if (/\bos\.environ\b/.test(joined)) return true;
  if (argv.some((a) => a === "pi" || /(^|\/)pi$/.test(a))) return true;
  return false;
}

function capped(buf: Buffer): string {
  return buf.length <= OUTPUT_CAP ? buf.toString("utf8") : buf.subarray(0, OUTPUT_CAP).toString("utf8");
}

/** Host-only: spawn `command` with `$SECRET` set. Never a worker tool in v1.5. */
export async function runWithSecret(opts: RunWithSecretOpts): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (wouldDumpEnv(opts.command, opts.argv)) {
    throw new Error(`UseSecret: refused command that would dump env or invoke pi (${opts.command})`);
  }
  const value = await opts.vault.getPlaintext(vaultNameOf(opts.name));
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const base = opts.env ?? process.env;
  const env: NodeJS.ProcessEnv = { SECRET: value };
  for (const key of WORKER_ENV_PASSTHROUGH) {
    const v = base[key];
    if (typeof v === "string" && v.length > 0) env[key] = v;
  }

  const scrub = makeScrubber([value]);
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.argv, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const chunksOut: Buffer[] = [];
    const chunksErr: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunksOut.push(c));
    child.stderr?.on("data", (c: Buffer) => chunksErr.push(c));
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      reject(new Error("UseSecret: timed out"));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: scrub(capped(Buffer.concat(chunksOut))),
        stderr: scrub(capped(Buffer.concat(chunksErr))),
        exitCode: code ?? 1,
      });
    });
  });
}
