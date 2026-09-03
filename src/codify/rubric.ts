import { DEFAULTS } from "../config/defaults.js";
import { matchGlob, matchesAny, normalizeRelPath } from "../gate/glob.js";
import { isPredicate } from "../lanes/catalog.js";

export const INPUT_TYPES = ["semver", "identifier", "relpath-in-globs", "enum", "shortText"] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export const ORACLES = ["fs", "regex", "exit-code", "input"] as const;
export type OracleKind = (typeof ORACLES)[number];

export const PROVENANCE = ["constant", "title:", "brief:", "plan:", "command:", "host:today", "config:"] as const;

const INPUT_TYPE_SET = new Set<string>(INPUT_TYPES);
const ORACLE_SET = new Set<string>(ORACLES);

const READONLY_GIT_SUB = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "describe",
  "rev-list",
  "blame",
  "grep",
  "shortlog",
  "name-rev",
  "hash-object",
  "diff-tree",
  "diff-index",
  "diff-files",
  "format-patch",
  "version",
  "help",
  "var",
  "check-ref-format",
  "show-ref",
  "for-each-ref",
]);

export interface AssessmentInput {
  name: string;
  type: string;
  provenance: string;
  description?: string;
  value?: string;
}

export interface AssessmentDecision {
  id: string;
  oracle: string;
  file?: string;
  pattern?: string;
  branches: string[];
}

export interface AssessmentBinding {
  name: string;
  value: string;
  memberRunId?: string;
}

export interface Assessment {
  verdict: RubricVerdict;
  inputs: AssessmentInput[];
  decisions: AssessmentDecision[];
  postconditions: string[];
  sideEffects: { writeGlobs: string[]; readGlobs: string[] };
  allowedCommands: string[];
  irreversible?: boolean;
  residuals: string[];
  bindings?: AssessmentBinding[];
}

export type RubricVerdict = "codifiable" | "assist-only" | "not-codifiable";
export type RubricRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";

export interface RubricResult {
  verdict: RubricVerdict;
  failed: { rule: RubricRule; at: "assess" | "validate"; note: string }[];
  residuals: string[];
}

export interface ClusterMember {
  runId: string;
  score?: number;
  title?: string;
  literals?: string[];
  diffTokens?: string[];
  observedBranches?: Record<string, string>;
}

export interface Cluster {
  signature: string;
  stage?: string;
  kind?: string;
  lane?: string;
  members: ClusterMember[];
  shape?: string | null;
}

export interface MemberTree {
  runId: string;
  files: Record<string, string>;
}

/** `(decisionId+memberRunId) → selected branch`. Tests inject a Map; production may pass a function. */
export type OracleRunner = (decisionId: string, memberRunId: string) => string | undefined;

export interface ScoreOptions {
  oracles?: OracleRunner | ReadonlyMap<string, string>;
  writeRoots?: readonly string[];
  testDir?: string;
  securityPaths?: readonly string[];
  checks?: readonly string[];
}

export function scoreAssessment(
  a: Assessment,
  cluster: Cluster,
  trees: MemberTree[],
  opts: ScoreOptions = {},
): RubricResult {
  const failed: RubricResult["failed"] = [];
  const fail = (rule: RubricRule, at: "assess" | "validate", note: string): void => {
    failed.push({ rule, at, note });
  };

  scoreR1(a, cluster, fail);
  scoreR2(a, cluster, trees, opts.oracles, fail);
  scoreR3(a, fail);
  scoreR5(a, cluster, opts, fail);
  scoreR6(a, cluster, fail);
  // R4 idempotency and R7 size are proved at validate (Task 2.3 / 5.2), never at assess.

  const assessFails = failed.some((f) => f.at === "assess");
  const verdict: RubricVerdict = assessFails
    ? "not-codifiable"
    : a.verdict === "assist-only" || a.verdict === "not-codifiable" || a.verdict === "codifiable"
      ? a.verdict
      : "codifiable";

  return { verdict, failed, residuals: [...a.residuals] };
}

function scoreR1(a: Assessment, cluster: Cluster, fail: FailFn): void {
  if (a.inputs.length > 6) {
    fail("R1", "assess", `inputs.length ${a.inputs.length} exceeds 6`);
  }
  for (const inp of a.inputs) {
    if (!INPUT_TYPE_SET.has(inp.type)) {
      fail("R1", "assess", `input ${inp.name} type ${JSON.stringify(inp.type)} is not in the host vocabulary`);
    }
    if (!provenanceAllowed(inp.provenance)) {
      fail("R1", "assess", `input ${inp.name} provenance ${JSON.stringify(inp.provenance)} is not in the host vocabulary`);
    }
  }
  if (a.residuals.length > 0) {
    fail("R1", "assess", `residuals must be empty at assess (${a.residuals.length} declared)`);
  }
  if (cluster.members.length === 1) {
    const member = cluster.members[0];
    const title = member?.title ?? "";
    for (const inp of a.inputs) {
      if (!isConstantProvenance(inp.provenance)) continue;
      for (const value of constantValues(a, inp)) {
        if (value.length > 0 && title.includes(value)) {
          fail("R1", "assess", `N=1 constant ${inp.name}=${JSON.stringify(value)} appears in the ticket title`);
        }
      }
    }
  }
}

function scoreR2(
  a: Assessment,
  cluster: Cluster,
  trees: MemberTree[],
  oracles: ScoreOptions["oracles"],
  fail: FailFn,
): void {
  const treeByRun = new Map(trees.map((t) => [t.runId, t]));
  for (const decision of a.decisions) {
    if (!ORACLE_SET.has(decision.oracle)) {
      fail("R2", "assess", `decision ${decision.id} oracle ${JSON.stringify(decision.oracle)} is not executable`);
    }
    for (const member of cluster.members) {
      const selected = selectBranch(decision, member, treeByRun.get(member.runId), oracles);
      const observed = member.observedBranches?.[decision.id] ?? decision.branches[0];
      if (selected === undefined) {
        fail("R2", "assess", `decision ${decision.id} selected no branch on ${member.runId}`);
        continue;
      }
      if (observed !== undefined && selected !== observed) {
        fail(
          "R2",
          "assess",
          `decision ${decision.id} selected ${JSON.stringify(selected)} on ${member.runId}, observed ${JSON.stringify(observed)}`,
        );
      }
    }
  }

  for (const member of cluster.members) {
    const covered = coveredTokens(a, member.runId);
    for (const token of member.diffTokens ?? []) {
      if (token.length === 0) continue;
      if (covered.has(token)) continue;
      fail("R2", "assess", `untemplated token ${JSON.stringify(token)} in ${member.runId} has no binding or decision branch`);
    }
  }
}

function scoreR3(a: Assessment, fail: FailFn): void {
  if (a.postconditions.length === 0) {
    fail("R3", "assess", "postconditions must be a non-empty verifiable set");
    return;
  }
  for (const pc of a.postconditions) {
    if (!isVerifiablePostcondition(pc)) {
      fail("R3", "assess", `postcondition ${JSON.stringify(pc)} is not a catalog predicate, checks:<name>, or read-only command`);
    }
  }
}

function scoreR5(a: Assessment, cluster: Cluster, opts: ScoreOptions, fail: FailFn): void {
  const writeRoots = opts.writeRoots ?? writeRootsFor(cluster.kind);
  const testDir = opts.testDir ?? DEFAULTS.repo.testDir;
  const securityPaths = opts.securityPaths ?? DEFAULTS.repo.securityPaths;
  const deny = [...testDirGlobs(testDir), ...securityPaths];

  for (const glob of a.sideEffects.writeGlobs) {
    if (!globCoveredBy(glob, writeRoots)) {
      fail("R5", "assess", `writeGlob ${JSON.stringify(glob)} is outside writeRoots`);
    }
    for (const d of deny) {
      if (globsIntersect(glob, d)) {
        fail("R5", "assess", `writeGlob ${JSON.stringify(glob)} intersects ${JSON.stringify(d)}`);
        break;
      }
    }
  }

  for (const cmd of a.allowedCommands) {
    if (!isReadonlyGitCommand(cmd)) {
      fail("R5", "assess", `allowedCommand ${JSON.stringify(cmd)} is not in the read-only git set`);
    }
  }
}

function scoreR6(a: Assessment, cluster: Cluster, fail: FailFn): void {
  for (const member of cluster.members) {
    for (const lit of member.literals ?? []) {
      if (lit.length === 0) continue;
      if (bindingCovers(a, member.runId, lit)) continue;
      fail("R6", "assess", `binding misses member ${member.runId} literal ${JSON.stringify(lit)}`);
    }
  }
}

type FailFn = (rule: RubricRule, at: "assess" | "validate", note: string) => void;

function provenanceAllowed(p: string): boolean {
  if (p === "constant" || p.startsWith("constant:")) return true;
  if (p === "host:today" || p.startsWith("host:today")) return true;
  if (p.startsWith("title:")) return true;
  if (p.startsWith("brief:")) return true;
  if (p.startsWith("plan:")) return true;
  if (p.startsWith("command:")) return true;
  if (p.startsWith("config:")) return true;
  return false;
}

function isConstantProvenance(p: string): boolean {
  return p === "constant" || p.startsWith("constant:");
}

function constantValues(a: Assessment, inp: AssessmentInput): string[] {
  const out: string[] = [];
  if (inp.value !== undefined && inp.value.length > 0) out.push(inp.value);
  for (const b of a.bindings ?? []) {
    if (b.name === inp.name && b.value.length > 0) out.push(b.value);
  }
  return out;
}

function selectBranch(
  decision: AssessmentDecision,
  member: ClusterMember,
  tree: MemberTree | undefined,
  oracles: ScoreOptions["oracles"],
): string | undefined {
  const key = `${decision.id}+${member.runId}`;
  if (oracles instanceof Map || isReadonlyMap(oracles)) {
    if (oracles.has(key)) return oracles.get(key);
  } else if (typeof oracles === "function") {
    const injected = oracles(decision.id, member.runId);
    if (injected !== undefined) return injected;
  }
  return defaultOracle(decision, tree);
}

function isReadonlyMap(value: ScoreOptions["oracles"]): value is ReadonlyMap<string, string> {
  return typeof value === "object" && value !== null && typeof (value as ReadonlyMap<string, string>).has === "function";
}

function defaultOracle(decision: AssessmentDecision, tree: MemberTree | undefined): string | undefined {
  if (decision.oracle === "input") return decision.branches[0];
  if (tree === undefined) return undefined;
  const file = decision.file === undefined ? undefined : normalizeRelPath(decision.file);
  const content = file === undefined ? undefined : tree.files[file];
  if (decision.oracle === "fs") {
    if (content === undefined) return undefined;
    if (decision.pattern !== undefined && decision.pattern.length > 0 && !contentIncludes(content, decision.pattern)) {
      return undefined;
    }
    return decision.branches[0];
  }
  if (decision.oracle === "regex") {
    if (content === undefined || decision.pattern === undefined) return undefined;
    try {
      if (!new RegExp(decision.pattern).test(content)) return undefined;
    } catch {
      return undefined;
    }
    return decision.branches[0];
  }
  return undefined;
}

function contentIncludes(content: string, pattern: string): boolean {
  if (content.includes(pattern)) return true;
  try {
    return new RegExp(pattern).test(content);
  } catch {
    return false;
  }
}

function coveredTokens(a: Assessment, memberRunId: string): Set<string> {
  const s = new Set<string>();
  for (const inp of a.inputs) {
    s.add(`{${inp.name}}`);
    if (inp.value !== undefined) s.add(inp.value);
  }
  for (const b of a.bindings ?? []) {
    if (b.memberRunId === undefined || b.memberRunId === memberRunId) s.add(b.value);
  }
  for (const d of a.decisions) {
    for (const br of d.branches) s.add(br);
  }
  return s;
}

function bindingCovers(a: Assessment, memberRunId: string, lit: string): boolean {
  for (const inp of a.inputs) {
    if (inp.value === lit) return true;
  }
  for (const b of a.bindings ?? []) {
    if (b.value !== lit) continue;
    if (b.memberRunId === undefined || b.memberRunId === memberRunId) return true;
  }
  return false;
}

function isVerifiablePostcondition(pc: string): boolean {
  const t = pc.trim();
  if (t.length === 0) return false;
  if (/^checks:[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(t)) return true;
  if (isPredicate(t)) return true;
  if (isReadonlyGitCommand(t)) return true;
  return false;
}

export function isReadonlyGitCommand(cmd: string): boolean {
  const t = cmd.trim().toLowerCase();
  if (t === "git-readonly" || t === "git-readonly set" || t === "git") return true;
  const parts = t.split(/\s+/);
  if (parts[0] !== "git") return false;
  const sub = parts[1];
  if (sub === undefined) return true;
  return READONLY_GIT_SUB.has(sub);
}

function writeRootsFor(kind: string | undefined): readonly string[] {
  const wr = DEFAULTS.repo.writeRoots;
  if (kind === "feature" || kind === "enhancement" || kind === "bug" || kind === "chore") return wr[kind];
  return wr.chore;
}

function testDirGlobs(testDir: string): string[] {
  const t = normalizeRelPath(testDir).replace(/\/+$/, "");
  if (t.length === 0) return [];
  return [t, `${t}/**`, `**/${t}/**`];
}

function stripGlob(g: string): string {
  let s = normalizeRelPath(g);
  if (s === "**" || s === "*") return "";
  s = s.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  s = s.replace(/\*\*$/, "").replace(/\*$/, "");
  return s;
}

function globCoveredBy(glob: string, roots: readonly string[]): boolean {
  const g = normalizeRelPath(glob);
  if (matchesAny(g, roots)) return true;
  const gs = stripGlob(g);
  if (gs.length > 0 && matchesAny(gs, roots)) return true;
  if (gs.length > 0 && matchesAny(`${gs}/dummy`, roots)) return true;
  for (const root of roots) {
    const r = normalizeRelPath(root);
    if (g === r) return true;
    const rs = stripGlob(r);
    if (gs.length > 0 && rs.length > 0 && (gs === rs || gs.startsWith(`${rs}/`))) return true;
    if (gs.length > 0 && matchGlob(gs, r)) return true;
  }
  return false;
}

function globsIntersect(a: string, b: string): boolean {
  const ga = normalizeRelPath(a);
  const gb = normalizeRelPath(b);
  if (ga === gb) return true;
  if (matchGlob(ga, gb) || matchGlob(gb, ga)) return true;
  const sa = stripGlob(ga);
  const sb = stripGlob(gb);
  if (sa.length === 0 || sb.length === 0) return true;
  if (sa === sb) return true;
  if (sa.startsWith(`${sb}/`) || sb.startsWith(`${sa}/`)) return true;
  if (matchGlob(sa, gb) || matchGlob(sb, ga)) return true;
  if (matchGlob(`${sa}/x`, gb) || matchGlob(`${sb}/x`, ga)) return true;
  return false;
}
