// src/safety/teams-config.ts
// Three-layer teams config loader: built-in defaults -> user yaml -> project yaml.
// YAML support is intentionally minimal (flat top-level keys, nested 1-level objects,
// arrays of strings either inline `[a, b]` or block `- a`/`- b`). No anchors, no flow maps,
// no multi-line scalars. Comments via `#`.

import { readFile, realpath } from "fs/promises";
import { homedir } from "os";
import {
  DEFAULT_DOMAINS,
  type BashPolicy,
  type DomainPolicy,
  type DomainPolicyMap,
} from "./default-domains.js";

export type TeamsConfig = {
  mode: "warn" | "block";
  domains: DomainPolicyMap;
  // Non-empty when an existing yaml file failed to parse. Doctor surfaces these
  // so users notice corrupt config instead of silently falling back to defaults.
  parseErrors: Array<{ path: string; error: string }>;
};

type RawValue = string | string[] | RawObject;
type RawObject = { [k: string]: RawValue };

/** Minimal YAML parser. Limitations:
 *  - Flat top-level mapping with nested mappings (1+ levels) and string-array values
 *  - Arrays: inline `[a, b]` or block `- a` lines
 *  - Strings: bare, single-quoted, or double-quoted
 *  - No anchors, no multi-doc, no folded scalars
 *  - Comments: `#` to end of line (outside quotes) */
export function parseMinimalYaml(text: string): RawObject {
  const lines = text.split(/\r?\n/);
  const root: RawObject = {};
  // Stack frames: { container, indent, lastKey, isList }
  type Frame = { container: RawObject | string[]; indent: number; lastKey?: string };
  const stack: Frame[] = [{ container: root, indent: -1 }];

  const stripComment = (raw: string): string => {
    let out = "";
    let inS = false;
    let inD = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "'" && !inD) inS = !inS;
      else if (ch === '"' && !inS) inD = !inD;
      else if (ch === "#" && !inS && !inD) break;
      out += ch;
    }
    return out;
  };

  const unquote = (s: string): string => {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
    return t;
  };

  const parseInlineArray = (s: string): string[] => {
    const inner = s.trim().slice(1, -1).trim();
    if (!inner) return [];
    const out: string[] = [];
    let cur = "";
    let inS = false;
    let inD = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "'" && !inD) { inS = !inS; cur += ch; continue; }
      if (ch === '"' && !inS) { inD = !inD; cur += ch; continue; }
      if (ch === "," && !inS && !inD) { out.push(unquote(cur)); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(unquote(cur));
    return out;
  };

  const indentOf = (line: string): number => {
    let n = 0;
    while (n < line.length && line[n] === " ") n++;
    return n;
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = stripComment(lines[lineNo]);
    if (!raw.trim()) continue;
    const indent = indentOf(raw);
    const content = raw.slice(indent);

    // Pop frames whose indent >= current indent (we descend back to or above this level).
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const frame = stack[stack.length - 1];

    // List item — owned by the most recent enclosing object frame's lastKey
    if (content.startsWith("- ") || content === "-") {
      const itemRaw = content === "-" ? "" : content.slice(2).trim();
      let owner: Frame | undefined;
      for (let i = stack.length - 1; i >= 0; i--) {
        const f = stack[i];
        if (!Array.isArray(f.container) && f.lastKey) { owner = f; break; }
      }
      if (!owner) continue;
      const key = owner.lastKey as string;
      const obj = owner.container as RawObject;
      const existing = obj[key];
      let list: string[];
      if (Array.isArray(existing)) {
        list = existing as string[];
      } else if (existing === undefined || (typeof existing === "object" && !Array.isArray(existing) && Object.keys(existing as object).length === 0)) {
        list = [];
        obj[key] = list;
      } else {
        continue;
      }
      list.push(unquote(itemRaw));
      continue;
    }

    // Mapping line: `key:` or `key: value`
    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;
    const key = content.slice(0, colonIdx).trim();
    const rest = content.slice(colonIdx + 1).trim();

    if (Array.isArray(frame.container)) continue; // malformed

    const obj = frame.container as RawObject;

    if (rest === "") {
      // Open a new nested object; the next non-list line at greater indent will populate it.
      // Default to {}; converted to [] lazily by list-item handler if needed.
      obj[key] = {};
      frame.lastKey = key;
      stack.push({ container: obj[key] as RawObject, indent });
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      obj[key] = parseInlineArray(rest);
      frame.lastKey = key;
      continue;
    }
    // Unclosed inline bracket — refuse rather than silently treating as a string.
    if (rest.startsWith("[") || rest.endsWith("]")) {
      throw new Error(`unclosed inline array at key '${key}': ${rest}`);
    }
    // Unclosed quote — same.
    if ((rest.startsWith('"') && !rest.endsWith('"')) || (rest.startsWith("'") && !rest.endsWith("'"))) {
      throw new Error(`unclosed quoted string at key '${key}': ${rest}`);
    }

    obj[key] = unquote(rest);
    frame.lastKey = key;
  }

  return root;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function unionStrings(a: string[] | undefined, b: string[] | undefined): string[] {
  const set = new Set<string>();
  for (const x of a ?? []) set.add(x);
  for (const x of b ?? []) set.add(x);
  return Array.from(set);
}

function mostRestrictiveBashPolicy(
  a: BashPolicy | undefined,
  b: BashPolicy | undefined,
): BashPolicy | undefined {
  // Presence wins. If both present, intersect allowed_scripts and prefer b's runner if specified.
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (b && !a) return b;
  const ax = a as BashPolicy;
  const bx = b as BashPolicy;
  return {
    mode: "script-only",
    runner: bx.runner || ax.runner,
    allowed_scripts: ax.allowed_scripts.filter((s) => bx.allowed_scripts.includes(s)),
  };
}

function mergePolicy(a: DomainPolicy, b: DomainPolicy): DomainPolicy {
  return {
    read: unionStrings(a.read, b.read),
    upsert: unionStrings(a.upsert, b.upsert),
    delete: unionStrings(a.delete, b.delete),
    bash_policy: mostRestrictiveBashPolicy(a.bash_policy, b.bash_policy),
    // force_block: any layer that asserts force_block wins. User config can
    // promote an agent to force_block but cannot demote one that DEFAULT_DOMAINS
    // declares (more-restrictive-wins).
    force_block: a.force_block || b.force_block || undefined,
  };
}

function mergeMaps(base: DomainPolicyMap, overlay: DomainPolicyMap): DomainPolicyMap {
  const out: DomainPolicyMap = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(overlay)]);
  for (const k of keys) {
    const a = base[k];
    const b = overlay[k];
    if (a && b) out[k] = mergePolicy(a, b);
    else if (a) out[k] = a;
    else if (b) out[k] = b;
  }
  return out;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return p.replace("~", homedir());
  if (p === "~") return homedir();
  return p;
}

function substitute(s: string, runDir: string, expertiseDir: string): string {
  return s.replace(/\$\{RUN_DIR\}/g, runDir).replace(/\$\{EXPERTISE_DIR\}/g, expertiseDir);
}

function substitutePolicy(
  p: DomainPolicy,
  runDir: string,
  expertiseDir: string,
): DomainPolicy {
  const sub = (s: string) => expandHome(substitute(s, runDir, expertiseDir));
  return {
    read: p.read.map(sub),
    upsert: p.upsert.map(sub),
    delete: p.delete.map(sub),
    force_block: p.force_block,
    bash_policy: p.bash_policy
      ? {
          mode: "script-only",
          runner: p.bash_policy.runner,
          allowed_scripts: p.bash_policy.allowed_scripts.map(sub),
        }
      : undefined,
  };
}

function rawToPolicy(raw: RawValue | undefined): DomainPolicy | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as RawObject;
  const read = isStringArray(r.read) ? (r.read as string[]) : [];
  const upsert = isStringArray(r.upsert) ? (r.upsert as string[]) : [];
  const del = isStringArray(r.delete) ? (r.delete as string[]) : [];
  let bash: BashPolicy | undefined;
  if (r.bash_policy && typeof r.bash_policy === "object" && !Array.isArray(r.bash_policy)) {
    const bp = r.bash_policy as RawObject;
    if (bp.mode === "script-only" && typeof bp.runner === "string" && isStringArray(bp.allowed_scripts)) {
      bash = {
        mode: "script-only",
        runner: bp.runner,
        allowed_scripts: bp.allowed_scripts as string[],
      };
    }
  }
  // Parse force_block from yaml. Codex P3.5 round-3 NEW-CRITICAL: previously
  // stripped here, making mergePolicy's most-restrictive-wins comment a lie —
  // user yaml could not promote an agent to force_block.
  let force_block: boolean | undefined;
  if (typeof r.force_block === "string") {
    force_block = r.force_block === "true";
  } else if (typeof r.force_block === "boolean") {
    force_block = r.force_block;
  }
  return { read, upsert, delete: del, bash_policy: bash, force_block };
}

function rawToMap(raw: RawObject): DomainPolicyMap {
  const out: DomainPolicyMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "mode") continue;
    const p = rawToPolicy(v);
    if (p) out[k] = p;
  }
  return out;
}

type YamlReadResult =
  | { kind: "missing" }
  | { kind: "parsed"; raw: RawObject; mode?: "warn" | "block" }
  | { kind: "error"; error: string };

async function readYamlFile(path: string): Promise<YamlReadResult> {
  let text: string;
  try {
    const realPath = await realpath(path).catch(() => path);
    text = await readFile(realPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error: (err as Error).message };
  }
  try {
    const raw = parseMinimalYaml(text);
    let mode: "warn" | "block" | undefined;
    if (raw.mode === "warn" || raw.mode === "block") mode = raw.mode;
    return { kind: "parsed", raw, mode };
  } catch (err) {
    return { kind: "error", error: `parse failed: ${(err as Error).message}` };
  }
}

export async function loadTeamsConfig(opts: {
  userPath: string;
  projectPath: string;
  runDir: string;
  expertiseDir: string;
}): Promise<TeamsConfig> {
  // Layer 1: built-in defaults (substitute placeholders).
  let merged: DomainPolicyMap = {};
  for (const [k, v] of Object.entries(DEFAULT_DOMAINS)) {
    merged[k] = substitutePolicy(v, opts.runDir, opts.expertiseDir);
  }
  let mode: "warn" | "block" = "warn";

  const parseErrors: Array<{ path: string; error: string }> = [];

  // Layer 2: user yaml.
  const user = await readYamlFile(opts.userPath);
  if (user.kind === "parsed") {
    const userMap = rawToMap(user.raw);
    const subbed: DomainPolicyMap = {};
    for (const [k, v] of Object.entries(userMap)) {
      subbed[k] = substitutePolicy(v, opts.runDir, opts.expertiseDir);
    }
    merged = mergeMaps(merged, subbed);
    if (user.mode) mode = user.mode;
  } else if (user.kind === "error") {
    parseErrors.push({ path: opts.userPath, error: user.error });
  }

  // Layer 3: project yaml.
  const project = await readYamlFile(opts.projectPath);
  if (project.kind === "parsed") {
    const projMap = rawToMap(project.raw);
    const subbed: DomainPolicyMap = {};
    for (const [k, v] of Object.entries(projMap)) {
      subbed[k] = substitutePolicy(v, opts.runDir, opts.expertiseDir);
    }
    merged = mergeMaps(merged, subbed);
    if (project.mode) mode = project.mode;
  } else if (project.kind === "error") {
    parseErrors.push({ path: opts.projectPath, error: project.error });
  }

  return { mode, domains: merged, parseErrors };
}
