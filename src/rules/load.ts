import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { canonicalJson } from "../config/json.js";
import { BUILTIN_RULES, RuleRecordSchema, type RuleRecord } from "./schema.js";
import { Value } from "typebox/value";

export type RuleLayer = "builtin" | "global" | "overrides" | "local";

export interface LoadedRules {
  rules: RuleRecord[];
  sha: string;
  provenance: Record<string, RuleLayer>;
}

export function globalRulesPath(home: string): string {
  return join(home, "rules.yaml");
}

export function localRulesPath(repoPath: string): string {
  return join(repoPath, ".pi", "factory-rules.local.yaml");
}

export function committedRulesPath(repoPath: string): string {
  return join(repoPath, ".pi", "factory-rules.yaml");
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function asRecords(raw: unknown): RuleRecord[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is RuleRecord => Value.Check(RuleRecordSchema, item));
  }
  if (typeof raw === "object" && raw !== null && "rules" in raw && Array.isArray((raw as { rules: unknown }).rules)) {
    return (raw as { rules: unknown[] }).rules.filter((item): item is RuleRecord => Value.Check(RuleRecordSchema, item));
  }
  if (Value.Check(RuleRecordSchema, raw)) return [raw];
  return [];
}

async function readRuleFile(path: string): Promise<RuleRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  if (text.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return [];
  }
  return asRecords(parsed);
}

function overlay(acc: Map<string, RuleRecord>, incoming: RuleRecord[], provenance: Record<string, RuleLayer>, layer: RuleLayer): void {
  for (const rule of incoming) {
    const prev = acc.get(rule.id);
    if (prev?.status === "locked") {
      acc.set(rule.id, { ...prev, status: "locked" });
      continue;
    }
    acc.set(rule.id, rule);
    provenance[rule.id] = layer;
  }
}

export function rulesSha(rules: readonly RuleRecord[]): string {
  return createHash("sha256").update(canonicalJson(rules)).digest("hex");
}

export async function loadEffectiveRules(opts: {
  home: string;
  repoPath?: string;
  reposEntryRules?: RuleRecord[];
}): Promise<LoadedRules> {
  const acc = new Map<string, RuleRecord>();
  const provenance: Record<string, RuleLayer> = {};
  for (const rule of BUILTIN_RULES) {
    acc.set(rule.id, { ...rule });
    provenance[rule.id] = "builtin";
  }
  overlay(acc, await readRuleFile(globalRulesPath(opts.home)), provenance, "global");
  overlay(acc, opts.reposEntryRules ?? [], provenance, "overrides");
  if (opts.repoPath !== undefined) {
    overlay(acc, await readRuleFile(localRulesPath(opts.repoPath)), provenance, "local");
  }
  const rules = [...acc.values()];
  return { rules, sha: rulesSha(rules), provenance };
}
