import { resolve } from "node:path";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { addRule, type RuleRecord } from "../rules/index.js";
import { screenText } from "../trackers/screen.js";
import { looksLikeSecret } from "../vault/input-guard.js";
import type { ParsedFactoryArgs } from "./router.js";

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function resolveTarget(parsed: ParsedFactoryArgs, deps: FactoryDeps): { global: boolean; repoPath?: string } {
  if (parsed.flags.global === true) return { global: true };
  const repo = flagString(parsed.flags, "repo");
  if (repo !== undefined) return { global: false, repoPath: repo };
  const cwd = resolve(process.cwd());
  const hit = deps.repos.find((r) => resolve(r) === cwd);
  if (hit === undefined) {
    throw new Error("remember: --repo or --global is required when cwd is not a registered repo");
  }
  return { global: false, repoPath: hit };
}

export async function runRemember(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<RuleRecord> {
  const quoted = flagString(parsed.flags, "task");
  const text = (quoted ?? parsed.args.join(" ")).trim();
  if (text.length === 0) throw new Error("remember: rule text is required");
  if (looksLikeSecret(text)) throw new Error("remember: looks like a secret; use /factory secret set");
  const target = resolveTarget(parsed, deps);
  const stageFlag = flagString(parsed.flags, "stage");
  const pathsFlag = flagString(parsed.flags, "paths");
  return addRule(text, {
    home: deps.home,
    ...target,
    screen: screenText,
    confirm: async () => true,
    ...(flagString(parsed.flags, "lane") === undefined ? {} : { lane: flagString(parsed.flags, "lane") }),
    ...(flagString(parsed.flags, "kind") === undefined ? {} : { kind: flagString(parsed.flags, "kind") }),
    ...(stageFlag === undefined ? {} : { stage: stageFlag.split(",").map((s) => s.trim()).filter(Boolean) }),
    ...(pathsFlag === undefined ? {} : { paths: pathsFlag.split(",").map((s) => s.trim()).filter(Boolean) }),
  });
}
