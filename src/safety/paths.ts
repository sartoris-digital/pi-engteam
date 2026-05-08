// src/safety/paths.ts
import { realpathSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";
import { isEnvFileAccess } from "./patterns.js";

/**
 * Phase 5 round-2 C2: resolve symlinks at the leaf or its immediate
 * parent so a worker can't bypass protected-path matching by writing
 * through a symlink. Walking further up (e.g. all the way to /) creates
 * false positives on macOS firmlinks like /home → /System/Volumes/Data/home,
 * which would otherwise flag every /home/* path as protected (matches
 * /System prefix). Returns the lexical path unchanged when neither leaf
 * nor parent can be resolved.
 */
function resolveAncestorRealpath(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    const tail = abs.slice(parent.length);
    try {
      const real = realpathSync(parent);
      return real + tail;
    } catch {
      return abs;
    }
  }
}

export function expandPath(p: string): string {
  if (p.startsWith("~/")) return p.replace("~", homedir());
  if (p === "~") return homedir();
  return p;
}

const PROTECTED_PREFIXES = [
  "/etc", "/usr", "/bin", "/sbin", "/boot",
  "/System", "/Library/System", "/private/etc", "/private/var/db",
  "/var/log", "/var/db", "/var/root",
];

function getProtectedHomePaths(): string[] {
  const home = homedir();
  return [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.config/gcloud`,
    `${home}/.kube`,
    `${home}/.netrc`,
    `${home}/.pgpass`,
    `${home}/Library/Keychains`,
    "/Library/Keychains",
  ];
}

const SECRET_FILE_PATTERNS = [
  /\/id_rsa$/,
  /\/id_rsa\./,
  /\/id_ed25519$/,
  /\/id_ed25519\./,
  /\/id_ecdsa$/,
  /\/id_ecdsa\./,
  /\.pem$/,
  /\.key$/,
  /\/credentials$/,
];

export function isProtectedPath(filePath: string): { blocked: boolean; reason?: string } {
  const expanded = expandPath(filePath);
  const abs = resolve(expanded);
  // Round-2 C2: also check the symlink-resolved variant so a worker can't
  // bypass the substring matches below by writing/reading through a
  // symlink whose lexical path looks innocent.
  const real = resolveAncestorRealpath(abs);
  const candidates = abs === real ? [abs] : [abs, real];

  for (const cand of candidates) {
    for (const prefix of PROTECTED_PREFIXES) {
      if (cand === prefix || cand.startsWith(prefix + "/")) {
        return { blocked: true, reason: `Protected system path: ${prefix}` };
      }
    }

    for (const homePath of getProtectedHomePaths()) {
      const expandedHome = expandPath(homePath);
      if (cand === expandedHome || cand.startsWith(expandedHome + "/")) {
        return { blocked: true, reason: `Protected credential path: ${homePath}` };
      }
    }

    for (const pattern of SECRET_FILE_PATTERNS) {
      if (pattern.test(cand)) {
        return { blocked: true, reason: `Secret file pattern match: ${pattern}` };
      }
    }

    const base = cand.split("/").pop() ?? "";
    if (isEnvFileAccess(base)) {
      return { blocked: true, reason: ".env file access blocked (except .env.sample/.env.example)" };
    }

    // Phase 5 §8.3 single-writer policy: only Memory Core writes expertise files.
    // Block on either the lexical or the realpath-resolved variant so a
    // worker that writes through a symlink can't smuggle changes in.
    if (cand.includes("/.pi/engineering-team/expertise")) {
      return {
        blocked: true,
        reason: "Expertise files are curated by Memory Core only (single-writer policy).",
      };
    }
  }

  return { blocked: false };
}
