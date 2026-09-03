import { readFile, rename, writeFile } from "node:fs/promises";
import type { SecretName } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * Token-shaped literals scrubbed from seeds (spec §2.6 / plan Task 3.2).
 * Fail-closed: if this list cannot be loaded, `scrubSeed` returns `{ ok: false }`.
 */
export const TOKEN_SHAPES: readonly RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._\-+=/]{20,}/g,
  /\b[a-fA-F0-9]{40,}\b/g,
  /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g,
];

export type ScrubSeedResult =
  | { ok: true; text: string; placeholders: SecretName[]; hits: number }
  | { ok: false };

function loadShapes(shapes: readonly RegExp[] | null | undefined): readonly RegExp[] | null {
  if (shapes === null) return null;
  const loaded = shapes ?? TOKEN_SHAPES;
  if (!Array.isArray(loaded) || loaded.length === 0) return null;
  return loaded;
}

interface Hit {
  start: number;
  end: number;
  value: string;
}

function collectHits(text: string, knownValues: string[], shapes: readonly RegExp[]): Hit[] {
  const hits: Hit[] = [];
  const exact = knownValues.filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  for (const value of exact) {
    let from = 0;
    while (from <= text.length - value.length) {
      const start = text.indexOf(value, from);
      if (start < 0) break;
      hits.push({ start, end: start + value.length, value });
      from = start + value.length;
    }
  }
  for (const re of shapes) {
    const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    copy.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = copy.exec(text)) !== null) {
      if (match[0].length === 0) {
        copy.lastIndex += 1;
        continue;
      }
      hits.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Hit[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    kept.push(hit);
    cursor = hit.end;
  }
  return kept;
}

export function scrubSeed(
  text: string,
  knownValues: string[],
  shapes: readonly RegExp[] | null = TOKEN_SHAPES,
): ScrubSeedResult {
  const loaded = loadShapes(shapes);
  if (loaded === null) return { ok: false };
  try {
    const hits = collectHits(text, knownValues, loaded);
    const placeholders: SecretName[] = [];
    const seen = new Map<string, SecretName>();
    let n = 1;
    let out = "";
    let cursor = 0;
    for (const hit of hits) {
      out += text.slice(cursor, hit.start);
      let ph = seen.get(hit.value);
      if (ph === undefined) {
        ph = `secret:UNBOUND_${n}` as SecretName;
        n += 1;
        seen.set(hit.value, ph);
        placeholders.push(ph);
      }
      out += ph;
      cursor = hit.end;
    }
    out += text.slice(cursor);
    return { ok: true, text: out, placeholders, hits: hits.length };
  } catch {
    return { ok: false };
  }
}

export async function knownVaultValues(vault: Vault): Promise<string[]> {
  const metas = await vault.list();
  const values: string[] = [];
  for (const meta of metas) {
    try {
      values.push(await vault.getPlaintext(meta.name));
    } catch {
      /* skip */
    }
  }
  return values;
}

/** Rewrite `path` in place (tmp+rename) through the seed scrubber. */
export async function scrubFile(path: string, vault: Vault): Promise<{ hits: number }> {
  const original = await readFile(path, "utf8");
  const values = await knownVaultValues(vault);
  const result = scrubSeed(original, values);
  if (!result.ok) throw new Error("secret scrub: token patterns unavailable");
  if (result.hits > 0) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, result.text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  }
  return { hits: result.hits };
}
