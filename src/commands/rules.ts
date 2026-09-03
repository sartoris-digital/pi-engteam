import type { FactoryDeps } from "../controller/lane-runner.js";
import { loadEffectiveRules } from "../rules/index.js";
import type { ParsedFactoryArgs } from "./router.js";

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export async function runRules(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<string> {
  const repo = flagString(parsed.flags, "repo") ?? parsed.args[0];
  const loaded = await loadEffectiveRules({
    home: deps.home,
    ...(repo === undefined ? {} : { repoPath: repo }),
  });
  const explain = parsed.flags.explain === true;
  if (loaded.rules.length === 0) return "no rules";
  return loaded.rules
    .map((rule) => {
      const layer = loaded.provenance[rule.id] ?? "-";
      return explain
        ? `${rule.id}\t${rule.status}\t${layer}\t${rule.class}\t${rule.text}`
        : `${rule.id}\t${rule.status}\t${rule.class}\t${rule.text}`;
    })
    .join("\n");
}
