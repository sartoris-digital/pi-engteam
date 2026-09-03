import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_HOME_ENV, ensureDirs } from "../../src/home.js";

export interface TmpHome {
  home: string;
  cleanup: () => Promise<void>;
}

/** Fresh factory home in a temp dir; sets PI_SDLC_HOME until cleanup(). */
export async function makeTmpHome(): Promise<TmpHome> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-sdlc-home-")));
  const previous = process.env[FACTORY_HOME_ENV];
  try {
    process.env[FACTORY_HOME_ENV] = home;
    await ensureDirs(home);
  } catch (err) {
    if (previous === undefined) delete process.env[FACTORY_HOME_ENV];
    else process.env[FACTORY_HOME_ENV] = previous;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  let cleaned = false;
  return {
    home,
    cleanup: async () => {
      if (cleaned) return;
      if (previous === undefined) delete process.env[FACTORY_HOME_ENV];
      else process.env[FACTORY_HOME_ENV] = previous;
      await rm(home, { recursive: true, force: true });
      cleaned = true;
    },
  };
}

export async function withTmpHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const t = await makeTmpHome();
  try {
    return await fn(t.home);
  } finally {
    await t.cleanup();
  }
}
