// picomatch-free glob subset: **, *, ?, {a,b}. Everything else is literal.

const REGEX_SPECIAL = /[.+^$()|[\]\\]/g;

function escapeLiteral(ch: string): string {
  return ch.replace(REGEX_SPECIAL, "\\$&");
}

function translate(glob: string): string {
  let out = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        const afterStars = i + 2;
        const atSegmentStart = i === 0 || glob.charAt(i - 1) === "/";
        if (atSegmentStart && glob.charAt(afterStars) === "/") {
          out += "(?:.*/)?"; // "**/" → zero or more whole segments
          i = afterStars + 1;
          continue;
        }
        out += ".*"; // trailing or embedded "**" → anything, slashes included
        i = afterStars;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (c === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close !== -1) {
        const alternatives = glob
          .slice(i + 1, close)
          .split(",")
          .map((alt) => translate(alt));
        out += "(?:" + alternatives.join("|") + ")";
        i = close + 1;
        continue;
      }
    }
    out += escapeLiteral(c);
    i += 1;
  }
  return out;
}

export function normalizeRelPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + translate(normalizeRelPath(glob)) + "$");
}

export function matchGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizeRelPath(path));
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  const rel = normalizeRelPath(path);
  for (const g of globs) {
    if (globToRegExp(g).test(rel)) return true;
  }
  return false;
}
