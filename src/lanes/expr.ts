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
