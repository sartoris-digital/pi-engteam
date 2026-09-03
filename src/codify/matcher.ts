import { matchesAny } from "../gate/glob.js";
import type { RegistryState } from "./registry.js";

export const MATCH_TIMEOUT_MS = 5;

export interface BoundedMatch {
  ok: boolean;
  timedOut?: boolean;
}

export interface Matchable {
  name: string;
  version: number;
  state: RegistryState;
  matcher: { titlePatterns: string[]; planStepPatterns: string[]; pathGlobs: string[] };
}

export interface MatchQuery {
  title: string;
  planSteps?: string[];
  likelyPaths?: string[];
}

export interface ToolMatch {
  name: string;
  version: number;
  titleHit: boolean;
  planStepHit: boolean;
  pathsFit: boolean;
  timedOut: boolean;
}

export const MATCHABLE_STATES: readonly RegistryState[] = ["active", "probationary", "assist"];

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*?](?:[^()\\]|\\.)*\)[+*?]/;

type Node =
  | { k: "seq"; xs: Node[] }
  | { k: "alt"; xs: Node[] }
  | { k: "rep"; x: Node; min: number; max: number | null }
  | { k: "lit"; c: string }
  | { k: "dot" }
  | { k: "bol" }
  | { k: "eol" };

class ParseError extends Error {}

function parse(src: string): Node {
  let i = 0;
  const peek = (): string => src[i] ?? "";
  const eat = (): string => src[i++] ?? "";

  function atom(): Node {
    const c = eat();
    if (c === "") throw new ParseError("eof");
    if (c === ".") return { k: "dot" };
    if (c === "^") return { k: "bol" };
    if (c === "$") return { k: "eol" };
    if (c === "\\") {
      const n = eat();
      if (n === "") throw new ParseError("dangling escape");
      return { k: "lit", c: n };
    }
    if (c === "(") {
      const inner = alt();
      if (eat() !== ")") throw new ParseError("unclosed group");
      return inner;
    }
    if (c === ")" || c === "|" || c === "*" || c === "+" || c === "?") throw new ParseError(`unexpected ${c}`);
    return { k: "lit", c };
  }

  function quantified(): Node {
    let node = atom();
    const q = peek();
    if (q === "*" || q === "+" || q === "?") {
      eat();
      node = { k: "rep", x: node, min: q === "+" ? 1 : 0, max: q === "?" ? 1 : null };
    }
    return node;
  }

  function seq(): Node {
    const xs: Node[] = [];
    while (i < src.length && peek() !== ")" && peek() !== "|") xs.push(quantified());
    return xs.length === 1 ? (xs[0] as Node) : { k: "seq", xs };
  }

  function alt(): Node {
    const xs = [seq()];
    while (peek() === "|") {
      eat();
      xs.push(seq());
    }
    return xs.length === 1 ? (xs[0] as Node) : { k: "alt", xs };
  }

  const ast = alt();
  if (i !== src.length) throw new ParseError("trailing");
  return ast;
}

interface Ctx {
  text: string;
  deadline: number;
  timedOut: boolean;
}

function expired(ctx: Ctx): boolean {
  if (ctx.timedOut) return true;
  if (performance.now() >= ctx.deadline) {
    ctx.timedOut = true;
    return true;
  }
  return false;
}

function exec(node: Node, i: number, ctx: Ctx, cont: (j: number) => boolean): boolean {
  if (expired(ctx)) return false;
  switch (node.k) {
    case "lit":
      return ctx.text[i] === node.c ? cont(i + 1) : false;
    case "dot":
      return i < ctx.text.length ? cont(i + 1) : false;
    case "bol":
      return i === 0 ? cont(i) : false;
    case "eol":
      return i === ctx.text.length ? cont(i) : false;
    case "seq": {
      const walk = (k: number, pos: number): boolean => {
        if (expired(ctx)) return false;
        if (k >= node.xs.length) return cont(pos);
        const child = node.xs[k];
        if (child === undefined) return false;
        return exec(child, pos, ctx, (n) => walk(k + 1, n));
      };
      return walk(0, i);
    }
    case "alt":
      for (const branch of node.xs) {
        if (exec(branch, i, ctx, cont)) return true;
        if (ctx.timedOut) return false;
      }
      return false;
    case "rep": {
      const greedy = (taken: number, pos: number): boolean => {
        if (expired(ctx)) return false;
        if (node.max !== null && taken >= node.max) return cont(pos);
        let advanced = false;
        const grew = exec(node.x, pos, ctx, (n) => {
          if (n === pos) return false;
          advanced = true;
          return greedy(taken + 1, n);
        });
        if (grew) return true;
        if (ctx.timedOut) return false;
        if (taken >= node.min && !advanced) return cont(pos);
        if (taken >= node.min) return cont(pos);
        return false;
      };
      return greedy(0, i);
    }
  }
}

function search(ast: Node, text: string, timeoutMs: number): BoundedMatch {
  const ctx: Ctx = { text, deadline: performance.now() + timeoutMs, timedOut: false };
  const anchored = ast.k === "seq" && ast.xs[0]?.k === "bol";
  const tryAt = (from: number): boolean => exec(ast, from, ctx, () => true);
  if (anchored) {
    const ok = tryAt(0);
    return ctx.timedOut ? { ok: false, timedOut: true } : { ok };
  }
  for (let from = 0; from <= text.length; from++) {
    if (tryAt(from)) return { ok: true };
    if (ctx.timedOut) return { ok: false, timedOut: true };
  }
  return { ok: false };
}

export function matchBounded(pattern: string, text: string, timeoutMs: number = MATCH_TIMEOUT_MS): BoundedMatch {
  if (NESTED_QUANTIFIER.test(pattern)) {
    try {
      return search(parse(pattern), text, timeoutMs);
    } catch {
      return { ok: false, timedOut: true };
    }
  }
  try {
    return { ok: new RegExp(pattern).test(text) };
  } catch {
    return { ok: false };
  }
}

function pathsFit(likelyPaths: string[], pathGlobs: string[]): boolean {
  if (pathGlobs.length === 0) return likelyPaths.length === 0;
  return likelyPaths.every((p) => matchesAny(p, pathGlobs));
}

export function matchTools(
  entries: readonly Matchable[],
  query: MatchQuery,
  timeoutMs: number = MATCH_TIMEOUT_MS,
): { matches: ToolMatch[]; timedOut: boolean; forcedPartial: boolean } {
  const matches: ToolMatch[] = [];
  let timedOut = false;
  for (const entry of entries) {
    if (!MATCHABLE_STATES.includes(entry.state)) continue;
    let titleHit = false;
    let planStepHit = false;
    let entryTimedOut = false;
    for (const pat of entry.matcher.titlePatterns) {
      const r = matchBounded(pat, query.title, timeoutMs);
      if (r.timedOut) {
        entryTimedOut = true;
        timedOut = true;
        break;
      }
      if (r.ok) titleHit = true;
    }
    if (!entryTimedOut) {
      for (const pat of entry.matcher.planStepPatterns) {
        for (const step of query.planSteps ?? []) {
          const r = matchBounded(pat, step, timeoutMs);
          if (r.timedOut) {
            entryTimedOut = true;
            timedOut = true;
            break;
          }
          if (r.ok) planStepHit = true;
        }
        if (entryTimedOut) break;
      }
    }
    if (entryTimedOut || (!titleHit && !planStepHit)) continue;
    matches.push({
      name: entry.name,
      version: entry.version,
      titleHit,
      planStepHit,
      pathsFit: pathsFit(query.likelyPaths ?? [], entry.matcher.pathGlobs),
      timedOut: false,
    });
  }
  return { matches, timedOut, forcedPartial: matches.length >= 2 };
}
