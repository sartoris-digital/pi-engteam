export class WhenError extends Error {
  readonly index: number | undefined;
  constructor(message: string, index?: number) {
    super(index === undefined ? message : `${message} at ${index}`);
    this.name = "WhenError";
    this.index = index;
  }
}

export type TokenKind =
  | "ident" | "string" | "number" | "true" | "false"
  | "eq" | "neq" | "and" | "or" | "not" | "in"
  | "lparen" | "rparen" | "dot" | "comma" | "eof";

export interface Token { kind: TokenKind; value: string; index: number }

const KEYWORDS: Record<string, TokenKind> = { true: "true", false: "false", in: "in" };

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string, index: number): void => {
    out.push({ kind, value, index });
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i += 1; continue; }
    if (c === "(") { push("lparen", "(", i++); continue; }
    if (c === ")") { push("rparen", ")", i++); continue; }
    if (c === ".") { push("dot", ".", i++); continue; }
    if (c === ",") { push("comma", ",", i++); continue; }
    if (c === "!" && src[i + 1] !== "=") { push("not", "!", i++); continue; }
    if (c === "=" && src[i + 1] === "=") { push("eq", "==", i); i += 2; continue; }
    if (c === "!" && src[i + 1] === "=") { push("neq", "!=", i); i += 2; continue; }
    if (c === "&" && src[i + 1] === "&") { push("and", "&&", i); i += 2; continue; }
    if (c === "|" && src[i + 1] === "|") { push("or", "||", i); i += 2; continue; }
    if (c === "=") throw new WhenError("expected '=='", i);
    if (c === "'" || c === '"') {
      const quote = c;
      const start = i++;
      let value = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) { value += src[i + 1]; i += 2; continue; }
        value += src[i];
        i += 1;
      }
      if (src[i] !== quote) throw new WhenError("unterminated string", start);
      i += 1;
      push("string", value, start);
      continue;
    }
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < src.length && src[i]! >= "0" && src[i]! <= "9") i += 1;
      if (src[i] === ".") {
        i += 1;
        while (i < src.length && src[i]! >= "0" && src[i]! <= "9") i += 1;
      }
      push("number", src.slice(start, i), start);
      continue;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
      const start = i;
      i += 1;
      while (i < src.length && /[A-Za-z0-9_-]/.test(src[i]!)) i += 1;
      const value = src.slice(start, i);
      push(KEYWORDS[value] ?? "ident", value, start);
      continue;
    }
    throw new WhenError(`unexpected character ${JSON.stringify(c)}`, i);
  }
  push("eof", "", i);
  return out;
}

export type Expr =
  | { type: "literal"; value: string | number | boolean }
  | { type: "path"; parts: string[] }
  | { type: "unary"; op: "!"; arg: Expr }
  | { type: "binary"; op: "==" | "!=" | "&&" | "||" | "in"; left: Expr; right: Expr }
  | { type: "call"; callee: string[]; arg: string };

export interface WhenContext {
  tier?: string;
  kind?: string;
  lane?: string;
  iteration?: number;
  rounds?: Record<string, number>;
  artifacts?: Record<string, unknown>;
  brief?: Record<string, unknown>;
  flags?: Record<string, unknown> | unknown[];
  size?: string;
  diff?: { touches?: (globKey: string) => boolean };
  repo?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseWhen(src: string): Expr {
  const tokens = tokenize(src);
  let i = 0;
  const peek = (): Token => tokens[i] ?? tokens[tokens.length - 1]!;
  const take = (kind?: TokenKind): Token => {
    const t = peek();
    if (kind && t.kind !== kind) throw new WhenError(`expected ${kind}, got ${t.kind}`, t.index);
    i += 1;
    return t;
  };
  const parseOr = (): Expr => {
    let left = parseAnd();
    while (peek().kind === "or") { take(); left = { type: "binary", op: "||", left, right: parseAnd() }; }
    return left;
  };
  const parseAnd = (): Expr => {
    let left = parseNot();
    while (peek().kind === "and") { take(); left = { type: "binary", op: "&&", left, right: parseNot() }; }
    return left;
  };
  const parseNot = (): Expr => {
    if (peek().kind === "not") { take(); return { type: "unary", op: "!", arg: parseNot() }; }
    return parseCmp();
  };
  const parseCmp = (): Expr => {
    const left = parsePrimary();
    const t = peek();
    if (t.kind === "eq" || t.kind === "neq" || t.kind === "in") {
      take();
      const op = t.kind === "eq" ? "==" : t.kind === "neq" ? "!=" : "in";
      return { type: "binary", op, left, right: parsePrimary() };
    }
    return left;
  };
  const parsePath = (): string[] => {
    const parts = [take("ident").value];
    while (peek().kind === "dot") { take(); parts.push(take("ident").value); }
    return parts;
  };
  const parsePrimary = (): Expr => {
    const t = peek();
    if (t.kind === "true") { take(); return { type: "literal", value: true }; }
    if (t.kind === "false") { take(); return { type: "literal", value: false }; }
    if (t.kind === "string") { take(); return { type: "literal", value: t.value }; }
    if (t.kind === "number") { take(); return { type: "literal", value: Number(t.value) }; }
    if (t.kind === "lparen") { take(); const inner = parseOr(); take("rparen"); return inner; }
    if (t.kind === "ident") {
      const parts = parsePath();
      if (peek().kind === "lparen") {
        take();
        const argTok = take("ident");
        take("rparen");
        if (parts.join(".") !== "diff.touches") throw new WhenError("only diff.touches(<globKey>) calls are allowed", t.index);
        return { type: "call", callee: parts, arg: argTok.value };
      }
      return { type: "path", parts };
    }
    throw new WhenError(`unexpected token ${t.kind}`, t.index);
  };
  if (peek().kind === "eof") throw new WhenError("empty expression");
  const expr = parseOr();
  if (peek().kind !== "eof") throw new WhenError("trailing input", peek().index);
  return expr;
}

function lookup(ctx: WhenContext, parts: string[]): unknown {
  let cur: unknown = ctx;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function truthy(value: unknown): boolean {
  return Boolean(value);
}

function inOp(left: unknown, right: unknown): boolean {
  if (Array.isArray(right)) return right.some((x) => x === left);
  if (right !== null && typeof right === "object") return typeof left === "string" && Object.prototype.hasOwnProperty.call(right, left);
  if (typeof right === "string" && typeof left === "string") return right.includes(left);
  return false;
}

function evalExpr(expr: Expr, ctx: WhenContext): unknown {
  switch (expr.type) {
    case "literal": return expr.value;
    case "path": return lookup(ctx, expr.parts);
    case "unary": return !truthy(evalExpr(expr.arg, ctx));
    case "call": {
      const fn = lookup(ctx, expr.callee);
      return typeof fn === "function" ? Boolean((fn as (k: string) => unknown)(expr.arg)) : false;
    }
    case "binary": {
      if (expr.op === "&&") return truthy(evalExpr(expr.left, ctx)) && truthy(evalExpr(expr.right, ctx));
      if (expr.op === "||") return truthy(evalExpr(expr.left, ctx)) || truthy(evalExpr(expr.right, ctx));
      const l = evalExpr(expr.left, ctx);
      const r = evalExpr(expr.right, ctx);
      if (expr.op === "in") return inOp(l, r);
      if (expr.op === "==") return l === r;
      return l !== r;
    }
  }
}

export function evalWhen(src: string, ctx: WhenContext): boolean {
  return truthy(evalExpr(parseWhen(src), ctx));
}
