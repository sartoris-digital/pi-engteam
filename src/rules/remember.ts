import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { tokenSetSimilarity } from "./dedupe.js";
import { globalRulesPath, loadEffectiveRules, localRulesPath } from "./load.js";
import { normaliseRuleText } from "./normalise.js";
import { RuleRecordSchema, type RuleClass, type RuleRecord } from "./schema.js";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";

export { normaliseRuleText } from "./normalise.js";
export { tokenSetSimilarity } from "./dedupe.js";

/** Mirrors Task 1.2 `ScreenFlags` so remember does not depend on the tracker module. */
export interface ScreenFlags {
  injectionSuspect: boolean;
  reasons: string[];
}

export class RuleDuplicateError extends Error {
  readonly existingId: string;
  constructor(existingId: string) {
    super(`near-duplicate of ${existingId} (similarity ≥ 0.6)`);
    this.name = "RuleDuplicateError";
    this.existingId = existingId;
  }
}

export class RuleSafetyError extends Error {
  readonly key: string;
  constructor(key: string, detail: string) {
    super(`rule would loosen safety (${key}): ${detail}`);
    this.name = "RuleSafetyError";
    this.key = key;
  }
}

export class RuleScreenError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`rule rejected as injection-suspect: ${reasons.join(", ")}`);
    this.name = "RuleScreenError";
    this.reasons = reasons;
  }
}

const DUPLICATE_THRESHOLD = 0.6;

const SAFETY_DENY: ReadonlyArray<{ re: RegExp; key: string }> = [
  { re: /\bskip(?:ping)? (?:the )?tests\b/i, key: "test" },
  { re: /\bbypass(?:es|ing)? (?:the )?judge\b/i, key: "judge" },
  { re: /\bdisable(?:s|d)? (?:the )?judge\b/i, key: "judge" },
  { re: /\bdisable(?:s|d)? (?:the )?sandbox\b/i, key: "sandbox" },
  { re: /\bwiden write-?roots\b/i, key: "writeRoots" },
  { re: /\bforce-?push\b/i, key: "force-push" },
  { re: /\bauto-?approve steer\b/i, key: "steer" },
];

function classifyRule(text: string): RuleClass {
  if (/\b(always|never|must|shall|do not|don't)\b/i.test(text)) return "constraint";
  return "guidance";
}

function slugFrom(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 3);
  const slug = (words.length > 0 ? words : ["rule"]).join("-");
  return slug.slice(0, 32);
}

function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function allocateId(text: string, existing: Set<string>, now: Date): string {
  const base = `r-${yyyymmdd(now)}-${slugFrom(text)}`;
  if (!existing.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!existing.has(id)) return id;
  }
  return `${base}-${now.getTime()}`;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function readStoredRules(path: string): Promise<RuleRecord[]> {
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
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is RuleRecord => Value.Check(RuleRecordSchema, item));
  }
  if (typeof parsed === "object" && parsed !== null && "rules" in parsed && Array.isArray((parsed as { rules: unknown }).rules)) {
    return (parsed as { rules: unknown[] }).rules.filter((item): item is RuleRecord => Value.Check(RuleRecordSchema, item));
  }
  return [];
}

async function writeStoredRules(path: string, rules: RuleRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = stringifyYaml({ schemaVersion: 1, rules }, { lineWidth: 0 });
  await writeFile(path, body.endsWith("\n") ? body : `${body}\n`, { encoding: "utf8", mode: 0o600 });
}

export const LOCAL_RULES_EXCLUDE = ".pi/factory-rules.local.yaml";

export async function ensureLocalRulesExcluded(repoPath: string): Promise<void> {
  try {
    await stat(join(repoPath, ".git"));
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  const excludePath = join(repoPath, ".git", "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((line) => line.trim() === LOCAL_RULES_EXCLUDE)) return;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await writeFile(excludePath, `${existing}${prefix}${LOCAL_RULES_EXCLUDE}\n`, "utf8");
}

function assertSafety(text: string): void {
  for (const { re, key } of SAFETY_DENY) {
    if (re.test(text)) throw new RuleSafetyError(key, text);
  }
}

export async function addRule(
  text: string,
  opts: {
    home: string;
    repoPath?: string;
    global?: boolean;
    lane?: string;
    stage?: string[];
    kind?: string;
    paths?: string[];
    screen: (t: string) => ScreenFlags;
    confirm?: () => Promise<boolean>;
  },
): Promise<RuleRecord> {
  const normalised = normaliseRuleText(text);
  if (normalised.length === 0) throw new Error("remember: empty rule text");
  const screened = opts.screen(text);
  const screenedNorm = opts.screen(normalised);
  if (screened.injectionSuspect || screenedNorm.injectionSuspect) {
    throw new RuleScreenError([...(screened.reasons ?? []), ...(screenedNorm.reasons ?? [])]);
  }
  assertSafety(`${text} ${normalised}`);

  const loaded = await loadEffectiveRules({
    home: opts.home,
    ...(opts.repoPath === undefined ? {} : { repoPath: opts.repoPath }),
  });
  for (const existing of loaded.rules) {
    if (existing.status === "retired") continue;
    if (tokenSetSimilarity(normalised, existing.text) >= DUPLICATE_THRESHOLD) {
      throw new RuleDuplicateError(existing.id);
    }
  }

  if (opts.confirm !== undefined && !(await opts.confirm())) {
    throw new Error("remember: not confirmed");
  }

  const now = new Date();
  const klass = classifyRule(normalised);
  const record: RuleRecord = {
    id: allocateId(normalised, new Set(loaded.rules.map((r) => r.id)), now),
    text: normalised,
    scope: {
      repo: "*",
      lane: opts.lane ?? "*",
      stage: opts.stage ?? ["implement", "review", "judge"],
      kind: opts.kind ?? "*",
      paths: opts.paths ?? [],
    },
    class: klass,
    enforce: klass === "guidance" ? ["prompt"] : ["prompt", "review", "judge"],
    createdAt: now.toISOString(),
    author: "operator",
    status: "active",
  };

  const global = opts.global === true;
  if (!global && opts.repoPath === undefined) {
    throw new Error("remember: repoPath is required unless --global");
  }
  const path = global ? globalRulesPath(opts.home) : localRulesPath(opts.repoPath!);
  const stored = await readStoredRules(path);
  stored.push(record);
  await writeStoredRules(path, stored);
  if (!global && opts.repoPath !== undefined) await ensureLocalRulesExcluded(opts.repoPath);
  return record;
}

export async function retireRule(
  id: string,
  opts: { home: string; repoPath?: string },
): Promise<RuleRecord> {
  const loaded = await loadEffectiveRules({
    home: opts.home,
    ...(opts.repoPath === undefined ? {} : { repoPath: opts.repoPath }),
  });
  const rule = loaded.rules.find((r) => r.id === id);
  if (rule === undefined) throw new Error(`forget: unknown rule ${id}`);
  if (rule.status === "locked" || loaded.provenance[id] === "builtin") {
    throw new Error(`forget: ${id} is locked`);
  }
  const layer = loaded.provenance[id];
  const path =
    layer === "local" && opts.repoPath !== undefined ? localRulesPath(opts.repoPath) : globalRulesPath(opts.home);
  const stored = await readStoredRules(path);
  const idx = stored.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error(`forget: ${id} is not stored in a writable layer`);
  const retired: RuleRecord = { ...stored[idx]!, status: "retired" };
  stored[idx] = retired;
  await writeStoredRules(path, stored);
  return retired;
}
