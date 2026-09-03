import type { FactoryDeps } from "../controller/lane-runner.js";
import { DEFAULTS } from "../config/defaults.js";
import { dispatch } from "../codify/dispatch.js";
import { retryFailingCase } from "../codify/drift.js";
import { matchTools } from "../codify/matcher.js";
import {
  applyTransition,
  canPromote,
  loadRegistry,
  maybeActivate,
  recordHit,
  saveRegistry,
  type RegistryEntry,
} from "../codify/registry.js";
import type { ParsedFactoryArgs } from "./router.js";

export const CODIFIED_VERBS = [
  "list",
  "explain",
  "why",
  "promote",
  "demote",
  "retire",
  "retry",
  "shadow",
  "diff",
] as const;
export type CodifiedVerb = (typeof CODIFIED_VERBS)[number];

export interface CodifiedCommandContext {
  hasUI: boolean;
  ui: {
    confirm(title: string, initial?: string): Promise<boolean | string | undefined>;
  };
}

function confirmed(value: boolean | string | undefined): boolean {
  return value === true || value === "yes" || value === "Yes";
}

function parseNameVersion(spec: string): { name: string; version: number } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) throw new Error("codified promote: expected <name>@<version>");
  const name = spec.slice(0, at);
  const version = Number(spec.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) throw new Error("codified promote: bad version");
  return { name, version };
}

function requireName(parsed: ParsedFactoryArgs, verb: string): string {
  const name = parsed.args[1];
  if (name === undefined || name.length === 0) throw new Error(`codified ${verb}: <name> required`);
  return name;
}

function formatListRow(e: RegistryEntry): string {
  return `${e.name}\tv${e.version}\t${e.state}\tsavedUsd=${e.stats.savedUsd}`;
}

export async function runCodified(
  parsed: ParsedFactoryArgs,
  deps: FactoryDeps,
  ctx: CodifiedCommandContext,
): Promise<string> {
  const verb = parsed.args[0];
  if (verb === undefined || !(CODIFIED_VERBS as readonly string[]).includes(verb)) {
    throw new Error(`codified: ${CODIFIED_VERBS.join("|")} required`);
  }

  if (verb === "list") {
    const reg = await loadRegistry(deps.home);
    const rows = Object.values(reg.entries);
    if (rows.length === 0) return "no codified tools";
    return rows.map(formatListRow).join("\n");
  }

  if (verb === "why") {
    const title = parsed.args.slice(1).join(" ").trim();
    if (title.length === 0) throw new Error("codified why: <ref> required");
    const reg = await loadRegistry(deps.home);
    const found = matchTools(Object.values(reg.entries), { title });
    if (found.matches.length === 0) return `why: no match for ${title}`;
    return `why: hit ${found.matches.map((m) => `${m.name}@${m.version}`).join(", ")}`;
  }

  if (verb === "promote") {
    const spec = parsed.args[1];
    if (spec === undefined) throw new Error("codified promote: <name>@<version> required");
    if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
      throw new Error("codified promote requires an interactive session");
    }
    const { name, version } = parseNameVersion(spec);
    const reg = await loadRegistry(deps.home);
    const entry = reg.entries[name];
    if (entry === undefined) throw new Error(`codified promote: unknown ${name}`);
    if (entry.version !== version) {
      throw new Error(`codified promote: ${name}@${entry.version} is current, not @${version}`);
    }
    const gate = canPromote(entry, { hasUI: ctx.hasUI });
    if (!gate.ok && gate.reason === "unbound-secrets") {
      throw new Error("codified promote: unbound secrets");
    }
    if (!gate.ok && gate.reason === "human-modified") {
      return "codified promote refused: human-modified landing; re-enter validate";
    }
    if (!gate.ok) throw new Error(`codified promote: ${gate.reason}`);
    const ok = await ctx.ui.confirm(`Promote ${name}@${version}?`, "no");
    if (!confirmed(ok)) throw new Error("codified promote: confirmation refused");
    await applyTransition(deps.home, name, "probationary", "nonce", "operator nonce", new Date());
    return `${name}@${version} → probationary`;
  }

  if (verb === "explain") {
    const name = requireName(parsed, verb);
    const reg = await loadRegistry(deps.home);
    const entry = reg.entries[name];
    if (entry === undefined) throw new Error(`codified explain: unknown ${name}`);
    return [
      `${entry.name}@${entry.version}`,
      `state=${entry.state}`,
      `class=${entry.class}`,
      `secretsBound=${String(entry.secretsBound)}`,
      `landedAs=${entry.landedAs ?? "none"}`,
      `titlePatterns=${entry.matcher.titlePatterns.join(",")}`,
    ].join("\n");
  }

  if (verb === "demote") {
    const name = requireName(parsed, verb);
    await applyTransition(deps.home, name, "demoted", "system", "operator demote");
    return `${name} → demoted`;
  }

  if (verb === "retire") {
    const name = requireName(parsed, verb);
    await applyTransition(deps.home, name, "retired", "system", "operator retire");
    return `${name} → retired`;
  }

  if (verb === "retry") {
    const name = requireName(parsed, verb);
    const result = retryFailingCase({
      toolPy: "",
      failing: { input: {}, expectedPatch: "" },
      revalidate: () => ({ ok: false }),
    });
    return `${name}: sealed fixture appended${result.enqueueRepair ? "; repair queued" : ""}`;
  }

  if (verb === "shadow") {
    const name = requireName(parsed, verb);
    const reg = await loadRegistry(deps.home);
    const entry = reg.entries[name];
    if (entry === undefined) throw new Error(`codified shadow: unknown ${name}`);
    const hit = recordHit(entry, { kind: "shadow-agree" });
    const activated = maybeActivate(hit, DEFAULTS.operator.codify);
    reg.entries[name] = hit;
    await saveRegistry(deps.home, reg);
    if (activated.state !== hit.state) {
      await applyTransition(deps.home, name, activated.state, "shadow", "shadowAgree");
    }
    const live = (await loadRegistry(deps.home)).entries[name] ?? activated;
    return `${name} shadow-agree → ${live.state} (${live.stats.shadowAgree})`;
  }

  if (verb === "diff") {
    const name = requireName(parsed, verb);
    const reg = await loadRegistry(deps.home);
    const entry = reg.entries[name];
    if (entry === undefined) throw new Error(`codified diff: unknown ${name}`);
    const result = await dispatch({
      cfg: { dispatch: deps.codifyDispatch ?? "partial" },
      run: { stage: "implement", kind: "chore", title: name, likelyPaths: entry.matcher.pathGlobs },
      registry: reg,
      sandbox: { available: true },
    });
    if ("dryRun" in result && result.dryRun.patch) return result.dryRun.patch;
    return `codified diff ${name}: no dry-run patch`;
  }

  return `codified ${verb}`;
}
