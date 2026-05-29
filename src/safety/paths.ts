// src/safety/paths.ts
import { realpathSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";
import { isEnvFileAccess } from "./patterns.js";

/**
 * Phase 5 round-2 C2 + round-3 M1: resolve symlinks at the leaf or any
 * existing ancestor so a worker can't bypass protected-path matching by
 * writing through a deep chain like `alias/missing/file.md` where only
 * `alias` exists and is a symlink to expertise/.
 *
 * macOS firmlink defense: `/home → /System/Volumes/Data/home` and similar
 * Apple firmlinks are transparent indirections, NOT user content under
 * /System for protected-path purposes. We strip a leading
 * `/System/Volumes/Data` prefix from the resolved path so the protected
 * /System prefix doesn't false-positive on every /home/* path.
 *
 * Returns the lexical path unchanged when no ancestor can be resolved.
 */
function resolveAncestorRealpath(abs: string): string {
  let resolved: string | undefined;
  try {
    resolved = realpathSync(abs);
  } catch {
    let cur = abs;
    let suffix = "";
    while (cur !== dirname(cur)) {
      const parent = dirname(cur);
      const tail = cur.slice(parent.length);
      try {
        const real = realpathSync(parent);
        resolved = real + tail + suffix;
        break;
      } catch {
        suffix = tail + suffix;
        cur = parent;
      }
    }
  }
  if (!resolved) return abs;
  // Strip macOS firmlink prefix so /home/* isn't false-flagged as /System.
  const FIRMLINK = "/System/Volumes/Data";
  if (resolved.startsWith(FIRMLINK + "/")) {
    return resolved.slice(FIRMLINK.length);
  }
  return resolved;
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

export function isProtectedPath(filePath: string, opts?: { runsDir?: string }): { blocked: boolean; reason?: string } {
  const expanded = expandPath(filePath);
  const abs = resolve(expanded);
  // Phase 5.5 round-3 M1: a configured runsDir lets the tasks.json rule
  // protect non-standard layouts (e.g., a custom runsDir that doesn't
  // contain "/runs/" in its path).
  const runsDirAbs = opts?.runsDir ? resolve(expandPath(opts.runsDir)) : undefined;
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

    // Codex round-9 HIGH: `_agent_tmp` is the shared scratch dir where the
    // controller writes per-deliver verdict files and system prompt
    // assemblies. A sibling worker that read/wrote there could
    // (a) snoop another agent's verdict before the host consumed it,
    // (b) overwrite a peer's verdict to forge PASS, or
    // (c) read system prompt contents leaked by other agents.
    // Block ALL agent access — only the host process owns this dir.
    if (/(^|\/)_agent_tmp(\/|$)/.test(cand) || cand.includes("/runs/_agent_tmp")) {
      return {
        blocked: true,
        reason: "_agent_tmp is host-controlled scratch for verdict + system-prompt files; agents must not Read/Write/Bash there.",
      };
    }

    // Phase 5.5 round-2 C2 + round-3 M1: tasks.json under a run directory
    // must only be modified via TaskUpdate (which validates taskId shape).
    // A direct Bash/Write/Edit to tasks.json would let a worker plant
    // unsafe records that orchestrator reminders later read back.
    //
    // Round-3 M1: prefer a configured runsDir prefix check over the
    // marker-based heuristic, so a custom runsDir layout (e.g.,
    // /tmp/eng-state) is still protected. Fall through to the marker
    // check when no runsDir is configured.
    if (/\/tasks\.json$/i.test(cand)) {
      const runsDirMatch = runsDirAbs && (cand === runsDirAbs || cand.startsWith(runsDirAbs + "/"));
      const markerMatch = /(?:\/runs\/|\/engineering-team\/runs\/)/i.test(cand);
      if (runsDirMatch || markerMatch) {
        return {
          blocked: true,
          reason: "Run tasks.json is managed by the TaskUpdate tool only.",
        };
      }
    }

    // Phase A item 9 + round 2 HIGH #1 + round 15 HIGH #3: extend
    // orchestrator-owned path protection under runDir. Each path is
    // host-managed; agents read but never write. Layer D upserts may
    // include the parent runDir for artifact synthesis, but these
    // specific files must remain orchestrator-only even then.
    const runUnderRuns =
      (runsDirAbs && (cand === runsDirAbs || cand.startsWith(runsDirAbs + "/"))) ||
      /(?:\/runs\/|\/engineering-team\/runs\/)/i.test(cand);
    if (runUnderRuns) {
      // Phase 2 (controller-judge-approval): block agent access to the
      // _controller pseudo-run dir so no agent can cat the HMAC secret or
      // write a forged approval token via Write/Edit/Bash-redirect.
      if (/(^|\/)_controller(\/|$)/.test(cand)) {
        return {
          blocked: true,
          reason: "_controller approval context is operator-owned; agents must not read the secret or write tokens here.",
        };
      }

      const ORCH_OWNED = [
        /\/state\.json$/i,
        /\/events\.jsonl$/i,
        /\/conversation\.jsonl$/i,
        /\/agent-activity\.jsonl$/i,
        /\/feature-decisions\.json$/i,
        /(^|\/)_verdicts(\/|$)/i,
        /(^|\/)_telemetry(\/|$)/i,
        /(^|\/)_activity(\/|$)/i,
      ];
      for (const pat of ORCH_OWNED) {
        if (pat.test(cand)) {
          // Phase A item 4: narrow exception for the agent's OWN
          // verdict slot under `_verdicts/`. The orchestrator pre-
          // creates the slot and exports its absolute path via
          // PI_ENGINEERING_VERDICT_FILE; the agent's `write`/`edit`
          // tool recovery path lands there. Layer A keys the
          // exception on the env-var-exact path so a different slot
          // (a peer agent's) remains blocked.
          if (pat.source.includes("_verdicts")) {
            const allowedVerdict = process.env.PI_ENGINEERING_VERDICT_FILE;
            if (allowedVerdict && cand === resolve(expandPath(allowedVerdict))) {
              continue;
            }
          }
          return {
            blocked: true,
            reason: `Orchestrator-owned path under runDir (${pat.source}) — agents read but never write.`,
          };
        }
      }
    }
  }

  return { blocked: false };
}
