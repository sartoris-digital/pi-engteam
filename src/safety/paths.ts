// src/safety/paths.ts
import { homedir } from "os";
import { resolve } from "path";
import { isEnvFileAccess } from "./patterns.js";

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

  for (const prefix of PROTECTED_PREFIXES) {
    if (abs === prefix || abs.startsWith(prefix + "/")) {
      return { blocked: true, reason: `Protected system path: ${prefix}` };
    }
  }

  for (const homePath of getProtectedHomePaths()) {
    const expandedHome = expandPath(homePath);
    if (abs === expandedHome || abs.startsWith(expandedHome + "/")) {
      return { blocked: true, reason: `Protected credential path: ${homePath}` };
    }
  }

  for (const pattern of SECRET_FILE_PATTERNS) {
    if (pattern.test(abs)) {
      return { blocked: true, reason: `Secret file pattern match: ${pattern}` };
    }
  }

  const base = abs.split("/").pop() ?? "";
  if (isEnvFileAccess(base)) {
    return { blocked: true, reason: ".env file access blocked (except .env.sample/.env.example)" };
  }

  // Phase 5 §8.3 single-writer policy: only Memory Core writes expertise files.
  // Block worker subprocess writes to either layer (user-global or
  // project-local). The match is a substring on the canonical absolute path
  // so it catches both ~/.pi/engineering-team/expertise/* and
  // <cwd>/.pi/engineering-team/expertise/*. Reads are NOT blocked — agents
  // legitimately read their own curated expertise via the boot-time injection
  // path inside the controller.
  if (abs.includes("/.pi/engineering-team/expertise")) {
    return {
      blocked: true,
      reason: "Expertise files are curated by Memory Core only (single-writer policy).",
    };
  }

  return { blocked: false };
}
