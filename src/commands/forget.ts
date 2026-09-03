import type { FactoryDeps } from "../controller/lane-runner.js";
import { retireRule, type RuleRecord } from "../rules/index.js";
import type { ParsedFactoryArgs } from "./router.js";

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export async function runForget(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<RuleRecord> {
  const id = parsed.args[0];
  if (id === undefined || id.length === 0) throw new Error("forget: missing rule id");
  const repo = flagString(parsed.flags, "repo");
  return retireRule(id, {
    home: deps.home,
    ...(repo === undefined ? {} : { repoPath: repo }),
  });
}
