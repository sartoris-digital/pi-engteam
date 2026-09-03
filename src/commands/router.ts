export const SUBCOMMANDS = ["setup", "enqueue", "start", "approve", "status", "landed", "closed", "reconcile"] as const;
export type FactoryVerb = (typeof SUBCOMMANDS)[number];

export interface ParsedFactoryArgs {
  verb: FactoryVerb | null;
  args: string[];
  flags: Record<string, string | boolean>;
  error?: string;
}

export function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

export function parseFactoryArgs(raw: string): ParsedFactoryArgs {
  const tokens = tokenize(raw.trim());
  if (tokens.length === 0) return { verb: null, args: [], flags: {}, error: "bad arguments" };
  const [head, ...rest] = tokens;
  if (!(SUBCOMMANDS as readonly string[]).includes(head ?? "")) {
    return {
      verb: null,
      args: rest,
      flags: {},
      error: `unknown subcommand ${head} (setup|enqueue|start|approve|status|landed|closed|reconcile)`,
    };
  }
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    args.push(tok);
  }
  return { verb: head as FactoryVerb, args, flags };
}
