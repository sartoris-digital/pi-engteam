export const PROVIDER_TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-proj-[A-Za-z0-9_-]{40,}/g,
  /sk-[A-Za-z0-9]{40,}/g,
  /github_pat_[A-Za-z0-9_]{82}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /gho_[A-Za-z0-9]{36}/g,
  /ghu_[A-Za-z0-9]{36}/g,
  /ghs_[A-Za-z0-9]{36}/g,
  /xox[bp]-\d+-\d+-[A-Za-z0-9]+/g,
  /AKIA[0-9A-Z]{16}/g,
];

function loadPatterns(patterns: readonly RegExp[] | null | undefined): readonly RegExp[] {
  if (patterns === null) throw new Error("provider token patterns unavailable");
  const loaded = patterns ?? PROVIDER_TOKEN_PATTERNS;
  if (!Array.isArray(loaded) || loaded.length === 0) throw new Error("provider token patterns unavailable");
  return loaded;
}

export function makeScrubber(
  values: string[],
  patterns: readonly RegExp[] | null = PROVIDER_TOKEN_PATTERNS,
): (text: string) => string {
  let loaded: readonly RegExp[];
  try {
    loaded = loadPatterns(patterns);
  } catch {
    return () => "[redacted]";
  }
  const exact = values.filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  return (text: string): string => {
    try {
      let out = text;
      for (const value of exact) out = out.split(value).join("[redacted]");
      for (const re of loaded) {
        const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
        out = out.replace(copy, "[redacted]");
      }
      return out;
    } catch {
      return "[redacted]";
    }
  };
}
