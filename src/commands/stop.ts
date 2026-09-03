import type { FactoryDeps } from "../controller/lane-runner.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runStop(_parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<string> {
  if (deps.scheduler === undefined) return "scheduler not running";
  await deps.scheduler.stop();
  return "scheduler stopped";
}
