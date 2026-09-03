import type { FeatureVector, MechanicalShape, StageDiff, StageExecution } from "./types.js";

export const FEATURE_WEIGHTS = {
  reproducibleByCommand: 0.35,
  diffIsSubstitution: 0.2,
  literalsSourced: 0.15,
  zeroFixRounds: 0.1,
  lowModelEffort: 0.1,
  planImperative: 0.05,
  small: 0.05,
} as const;

export const MECHANICAL_SHAPES = [
  "version-bump",
  "dependency-companion",
  "changelog-entry",
  "codegen-docs",
  "boilerplate-from-sibling",
  "migration-scaffold",
  "rename",
  "config-toggle",
  "header-insertion",
  "formatting-only",
] as const satisfies readonly MechanicalShape[];

const REPRO_BINS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "uv",
  "make",
  "cargo",
  "go",
  "python",
  "python3",
  "node",
  "tsx",
]);

const IMPERATIVE = /^(bump|add|set|update|rename|insert|sync|regenerate|format|toggle|replace|move|delete|remove|create|write|copy|generate)\b/i;
const SEMVER = /\d+\.\d+\.\d+/;
const VERSION_MANIFEST = /(?:^|\/)(package\.json|Cargo\.toml|pyproject\.toml|composer\.json|Chart\.yaml)$/;
const VERSION_LOCK = /(?:^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|uv\.lock|composer\.lock)$/;
const CHANGELOG = /(?:^|\/)(CHANGELOG(?:\.(md|txt))?|changelog(?:\.(md|txt))?|CHANGES(?:\.md)?)$/i;
const MIGRATION = /(^|\/)(migrations?|alembic|flyway|liquibase)(\/|$)/i;
const CONFIG_FILE = /\.(json|ya?ml|toml|ini|env)$/i;
const GENERATED = /(\.generated\.|\/generated\/|^generated\/|openapi|swagger)/i;

function binName(argv: string[]): string {
  const raw = argv[0] ?? "";
  const slash = raw.lastIndexOf("/");
  return (slash === -1 ? raw : raw.slice(slash + 1)).toLowerCase();
}

function isReproducibleCommand(argv: string[]): boolean {
  const bin = binName(argv);
  if (bin === "" || bin === "git") return false;
  if (REPRO_BINS.has(bin)) return true;
  return argv.some((a) => a === "version" || a.includes("generate"));
}

function totalHunks(diff: StageDiff): number {
  return diff.files.reduce((n, f) => n + f.hunkLines, 0);
}

function isSubstitution(diff: StageDiff): boolean {
  if (diff.files.length === 0 || diff.files.length > 5) return false;
  if (totalHunks(diff) > 80) return false;
  if (diff.literals.length === 0) return false;
  const sourced = new Set(diff.sourced);
  const hit = diff.literals.filter((l) => sourced.has(l)).length;
  return hit / diff.literals.length >= 0.5;
}

function literalsSourced(ex: StageExecution): boolean {
  if (ex.diff.literals.length === 0) return false;
  return ex.diff.literals.every(
    (l) =>
      ex.diff.sourced.includes(l) ||
      ex.briefLiterals.includes(l) ||
      ex.planLiterals.includes(l) ||
      ex.title.includes(l),
  );
}

function planIsImperative(ex: StageExecution): boolean {
  return [ex.title, ...ex.planLiterals].some((t) => IMPERATIVE.test(t.trim()));
}

export function featuresOf(ex: StageExecution): FeatureVector {
  if (ex.features !== undefined) return ex.features;
  return {
    reproducibleByCommand: ex.commands.some((c) => isReproducibleCommand(c.argv)) ? 1 : 0,
    diffIsSubstitution: isSubstitution(ex.diff) ? 1 : 0,
    literalsSourced: literalsSourced(ex) ? 1 : 0,
    zeroFixRounds: ex.fixRounds === 0 ? 1 : 0,
    lowModelEffort: ex.toolCallCount <= 15 ? 1 : 0,
    planImperative: planIsImperative(ex) ? 1 : 0,
    small: ex.changedFiles.length <= 5 && totalHunks(ex.diff) <= 60 ? 1 : 0,
  };
}

export function scoreFeatures(f: FeatureVector): number {
  let sum = 0;
  (Object.keys(FEATURE_WEIGHTS) as (keyof typeof FEATURE_WEIGHTS)[]).forEach((key) => {
    const raw = f[key];
    const v = typeof raw === "number" && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    sum += FEATURE_WEIGHTS[key] * v;
  });
  return Math.min(1, Math.max(0, sum));
}

function isVersionBump(ex: StageExecution): boolean {
  const files = ex.changedFiles;
  const hasManifest = files.some((f) => VERSION_MANIFEST.test(f));
  const hasLock = files.some((f) => VERSION_LOCK.test(f));
  const semverLit = [...ex.diff.literals, ...ex.diff.sourced, ex.title].some((s) => SEMVER.test(s));
  if (!semverLit || !hasManifest) return false;
  if (hasLock) return true;
  return files.length <= 3 && files.every((f) => VERSION_MANIFEST.test(f) || VERSION_LOCK.test(f));
}

function isDependencyCompanion(ex: StageExecution): boolean {
  const files = ex.changedFiles;
  return files.some((f) => VERSION_MANIFEST.test(f)) && files.some((f) => VERSION_LOCK.test(f)) && !isVersionBump(ex);
}

function similarAdds(ex: StageExecution): boolean {
  const adds = ex.diff.files.filter((f) => f.op === "A");
  if (adds.length < 2) return false;
  const dirs = new Set(adds.map((f) => f.path.split("/").slice(0, -1).join("/")));
  return dirs.size <= 2;
}

export function detectMechanicalShape(input: StageExecution): MechanicalShape | null {
  const files = input.changedFiles;
  const title = input.title.toLowerCase();
  if (isVersionBump(input)) return "version-bump";
  if (isDependencyCompanion(input)) return "dependency-companion";
  if (files.some((f) => CHANGELOG.test(f))) return "changelog-entry";
  if (files.some((f) => GENERATED.test(f)) || input.commands.some((c) => c.argv.some((a) => a.includes("generate")))) {
    return "codegen-docs";
  }
  if (similarAdds(input) && files.length >= 2 && files.length <= 8) return "boilerplate-from-sibling";
  if (files.some((f) => MIGRATION.test(f))) return "migration-scaffold";
  if (/\brename\b/.test(title) || (input.diff.files.filter((f) => f.op === "D").length > 0 && input.diff.files.filter((f) => f.op === "A").length > 0)) {
    return "rename";
  }
  if ((/\b(toggle|flag|enable|disable)\b/.test(title) || files.every((f) => CONFIG_FILE.test(f))) && files.length <= 3 && totalHunks(input.diff) <= 40) {
    if (files.every((f) => CONFIG_FILE.test(f))) return "config-toggle";
  }
  if (/\b(header|license)\b/.test(title)) return "header-insertion";
  if (input.diff.literals.length === 0 && /\b(format|prettier|eslint)\b/.test(title)) return "formatting-only";
  return null;
}
