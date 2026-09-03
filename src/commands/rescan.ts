import type { FactoryDeps } from "../controller/lane-runner.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runRescan(_parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<{ claimed: number; skipped: number }> {
  if (deps.scheduler === undefined) throw new Error("rescan: no scheduler");
  return deps.scheduler.drainOnce();
}
