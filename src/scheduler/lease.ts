import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPidAlive } from "../workspace/lock.js";

export interface DaemonLease {
  holder: boolean;
  pid: number;
  path: string;
  stop(): Promise<void>;
}

export interface AcquireLeaseOptions {
  now?: () => Date;
  renewMs?: number;
  staleMs?: number;
  isAlive?: (pid: number) => boolean;
  pid?: number;
}

interface OwnerJson {
  pid: number;
  at: string;
}

const OWNER_FILE = "owner.json";
const DEFAULT_RENEW_MS = 60_000;
const DEFAULT_STALE_MS = 180_000;

export function leasePath(runsDir: string): string {
  return join(runsDir, "_factory", "daemon.lease");
}

async function readOwner(dir: string): Promise<OwnerJson | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, OWNER_FILE), "utf8")) as Partial<OwnerJson>;
    if (typeof raw.pid !== "number" || typeof raw.at !== "string") return null;
    return { pid: raw.pid, at: raw.at };
  } catch {
    return null;
  }
}

async function writeOwner(dir: string, owner: OwnerJson): Promise<void> {
  await writeFile(join(dir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function takeOver(dir: string): Promise<void> {
  const graveyard = `${dir}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(dir, graveyard);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await rm(graveyard, { recursive: true, force: true });
}

function ageMs(owner: OwnerJson, now: Date): number {
  const at = Date.parse(owner.at);
  if (Number.isNaN(at)) return Number.POSITIVE_INFINITY;
  return now.getTime() - at;
}

export async function acquireDaemonLease(runsDir: string, opts: AcquireLeaseOptions = {}): Promise<DaemonLease> {
  const dir = leasePath(runsDir);
  const now = opts.now ?? (() => new Date());
  const renewMs = opts.renewMs ?? DEFAULT_RENEW_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const alive = opts.isAlive ?? isPidAlive;
  const pid = opts.pid ?? process.pid;
  await mkdir(join(runsDir, "_factory"), { recursive: true, mode: 0o700 });

  const tryMkdir = async (): Promise<boolean> => {
    try {
      await mkdir(dir);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  for (let i = 0; i < 3; i++) {
    if (await tryMkdir()) {
      const owner: OwnerJson = { pid, at: now().toISOString() };
      await writeOwner(dir, owner);
      let timer: ReturnType<typeof setInterval> | undefined;
      const renew = (): void => {
        const next: OwnerJson = { pid, at: now().toISOString() };
        void writeOwner(dir, next).catch(() => undefined);
      };
      timer = setInterval(renew, renewMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      return {
        holder: true,
        pid,
        path: dir,
        stop: async () => {
          if (timer !== undefined) clearInterval(timer);
          timer = undefined;
          await rm(dir, { recursive: true, force: true });
        },
      };
    }
    const owner = await readOwner(dir);
    const dead = owner === null || !alive(owner.pid);
    const stale = owner === null || ageMs(owner, now()) >= staleMs;
    if (dead && stale) {
      await takeOver(dir);
      continue;
    }
    return {
      holder: false,
      pid: owner?.pid ?? 0,
      path: dir,
      stop: async () => undefined,
    };
  }
  return { holder: false, pid: 0, path: dir, stop: async () => undefined };
}
