import { matchesAny } from "../gate/glob.js";
import type { Brief } from "./brief-schema.js";

export interface DorFailure {
  check: string;
  detail: string;
}

export interface DorOk {
  ok: true;
}

export interface DorFail {
  ok: false;
  failures: DorFailure[];
  queueState: "needs-info" | "needs-triage";
}

export type DorResult = DorOk | DorFail;

export interface DorOpts {
  repoResolvable: boolean;
  body: string;
  assignedToHuman?: boolean;
  writeRoots: string[];
}

const PATH_RE = /(?:^|[\s`'"(])((?:src|lib|tests|docs|scripts|apps|packages)\/[\w./-]+|[\w./-]+\.[A-Za-z][\w]*)/;
const COMMAND_RE = /\b(pnpm|npm|yarn|npx|make|cargo|go|python|pytest|vitest|git)\b/;
const QUESTION_RE = /^(?:who|what|when|where|why|how|should|can|does|is|are)\b[\s\S]*\?\s*$/i;
const EPIC_RE = /\b(epic|cross-repo|multi-repo|across repos)\b/i;
const FAILURE_RE = /\b(error|fail(?:ure|ed)?|stack|exception|expected|actual|repro(?:duce)?)\b/i;

/** Strip template headings, HTML, and placeholders before the 80-char body check. */
export function stripTemplateBoilerplate(body: string): string {
  let s = body.replace(/\r\n?/g, "\n");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/^#{1,6}\s+.*$/gm, "");
  s = s.replace(/^\s*(TODO|TBD|FIXME|XXX|N\/A|_+)\s*$/gim, "");
  s = s.replace(/\{\{[^}]*\}\}/g, "");
  s = s.replace(/\[[^\]]*\]/g, "");
  s = s.replace(/[^\S\n]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{2,}/g, "\n");
  return s.trim();
}

function fail(check: string, detail: string): DorFailure {
  return { check, detail };
}

function hasQuotedOrDerived(brief: Brief): boolean {
  return brief.acceptanceCriteria.some((ac) => ac.source === "quoted" || ac.source === "derived");
}

function choreHasTarget(brief: Brief, body: string): boolean {
  if (brief.likelyPaths.length > 0) return true;
  if (PATH_RE.test(body)) return true;
  if (COMMAND_RE.test(body)) return true;
  return false;
}

/**
 * Host Definition of Ready (spec §3.6). Local tickets skip tracker ownership by
 * passing `assignedToHuman: false`; `repoResolvable` comes from `--repo`.
 */
export function evaluateDoR(brief: Brief, opts: DorOpts): DorResult {
  const failures: DorFailure[] = [];
  const stripped = stripTemplateBoilerplate(opts.body);

  if (!opts.repoResolvable) failures.push(fail("repo", "repo is not resolvable"));
  if (stripped.length < 80) failures.push(fail("body", `body is ${stripped.length} chars after stripping headings (need ≥ 80)`));
  if (stripped.length === 0) failures.push(fail("body", "no non-empty template section remains"));
  if (QUESTION_RE.test(stripped)) failures.push(fail("shape", "ticket is question-shaped"));
  if (EPIC_RE.test(opts.body)) failures.push(fail("shape", "cross-repo or epic marker"));
  if (opts.assignedToHuman === true) failures.push(fail("ownership", "assigned to a human in an active state"));
  if (brief.possibleDuplicateOf !== undefined) {
    failures.push(fail("duplicate", `possibleDuplicateOf ${brief.possibleDuplicateOf}`));
  }
  if (brief.size === "XL") failures.push(fail("size", "size XL is not ready"));

  if (brief.kind === "feature" || brief.kind === "enhancement" || brief.kind === "bug") {
    if (!hasQuotedOrDerived(brief)) {
      failures.push(fail("acceptanceCriteria", "need ≥ 1 quoted or derived acceptance criterion"));
    }
  }
  if (brief.kind === "feature" && brief.questions.length > 0) {
    failures.push(fail("questions", "feature briefs must have empty questions[]"));
  }
  if (brief.kind === "enhancement" && brief.confidence === "MEDIUM" && brief.questions.length > 0) {
    failures.push(fail("questions", "MEDIUM enhancement briefs must have empty questions[]"));
  }
  if (brief.kind === "bug" && brief.reproSteps !== "present" && !FAILURE_RE.test(opts.body)) {
    failures.push(fail("bug", "reproSteps absent and no diagnosable failure description"));
  }
  if (brief.kind === "chore" && !choreHasTarget(brief, opts.body)) {
    failures.push(fail("chore", "chore needs a concrete target path or command"));
  }

  const outside = brief.likelyPaths.filter((p) => !matchesAny(p, opts.writeRoots));
  if (outside.length > 0) {
    failures.push(fail("writeRoots", `add writeRoots (outside: ${outside.join(", ")})`));
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, failures, queueState: "needs-info" };
}
