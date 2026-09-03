import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEffectiveConfig } from "../config/effective.js";
import { globalConfigPath, readGlobal } from "../config/layers.js";
import { CATALOG, compileLane } from "../lanes/index.js";
import type { LaneDef, NamedLane } from "../lanes/schema.js";
import type { StageHooks } from "../lanes/hooks.js";
import { probeSandbox, type SandboxProbe } from "../runtime/sandbox.js";
import type { TrackerAdapter } from "../trackers/adapter.js";
import { SECRET_REF } from "../vault/resolve.js";
import { Vault, VaultUnavailableError } from "../vault/vault.js";

export type ProbeStatus = "pass" | "warn" | "fail";

export interface DoctorProbe {
  name: string;
  status: ProbeStatus;
  detail: string;
  fix?: string;
}

export interface DoctorMetrics {
  abstentionRate: number;
  landedAs: Record<"clean" | "human-modified" | "partial" | "closed", number>;
  escalations: Record<string, number>;
}

export interface DoctorLedgerEvent {
  ts?: string;
  type?: string;
  to?: string;
  from?: string;
  code?: string;
  landedAs?: string;
  [k: string]: unknown;
}

export interface DoctorInjects {
  detect?: (adapter: TrackerAdapter) => Promise<{ available: boolean; reason?: string }>;
  isPublic?: (repo: string) => Promise<boolean>;
  probeSandbox?: () => Promise<SandboxProbe>;
  envScrub?: () => Promise<{ leaked: string[] }>;
  diskFree?: () => Promise<{ homeBytes: number }>;
  lease?: { holder: boolean; ageSeconds: number; pid?: number };
  openVault?: () => Promise<Vault>;
  since?: Date;
}

const STUB_HOOKS: StageHooks = {
  agentStep: () => async () => ({ verdict: "PASS" }),
  hostStep: () => async () => ({ verdict: "PASS" }),
  humanStep: () => async () => ({ verdict: "PASS" }),
};

export async function readDoctorLedger(runsDir: string, since?: Date): Promise<DoctorLedgerEvent[]> {
  try {
    const raw = await readFile(join(runsDir, "_factory", "ledger.jsonl"), "utf8");
    const events: DoctorLedgerEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as DoctorLedgerEvent;
        if (since !== undefined && typeof parsed.ts === "string" && Date.parse(parsed.ts) < since.getTime()) continue;
        events.push(parsed);
      } catch {
        /* skip torn lines */
      }
    }
    return events;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

export function metricsFromLedger(events: DoctorLedgerEvent[]): DoctorMetrics {
  const landedAs = { clean: 0, "human-modified": 0, partial: 0, closed: 0 };
  const escalations: Record<string, number> = {};
  let claimed = 0;
  let abstained = 0;
  for (const ev of events) {
    const to = typeof ev.to === "string" ? ev.to : undefined;
    const type = typeof ev.type === "string" ? ev.type : "";
    if (type.includes("claimed") || to === "classifying" || to === "ready") claimed += 1;
    if (to === "needs-triage" || to === "needs-info" || to === "needs-decision") abstained += 1;
    if (ev.landedAs === "clean" || ev.landedAs === "human-modified" || ev.landedAs === "partial" || ev.landedAs === "closed") {
      landedAs[ev.landedAs] += 1;
    }
    const code = typeof ev.code === "string" ? ev.code : undefined;
    if (code !== undefined) escalations[code] = (escalations[code] ?? 0) + 1;
  }
  return {
    abstentionRate: claimed === 0 ? 0 : abstained / claimed,
    landedAs,
    escalations,
  };
}

export async function probeAdapters(
  adapters: Iterable<TrackerAdapter>,
  detect: (adapter: TrackerAdapter) => Promise<{ available: boolean; reason?: string }>,
): Promise<DoctorProbe> {
  const failures: string[] = [];
  const ids: string[] = [];
  for (const adapter of adapters) {
    ids.push(adapter.id);
    const result = await detect(adapter);
    if (!result.available) failures.push(`${adapter.id}: ${result.reason ?? "unavailable"}`);
  }
  if (failures.length > 0) {
    return {
      name: "adapters",
      status: "fail",
      detail: failures.join("; "),
      fix: "gh auth login (or disable the failing tracker in operator.trackers)",
    };
  }
  return {
    name: "adapters",
    status: "pass",
    detail: ids.length === 0 ? "no adapters" : `ok: ${ids.join(", ")}`,
  };
}

export async function probePublicRepos(
  repos: string[],
  isPublic: (repo: string) => Promise<boolean>,
): Promise<DoctorProbe> {
  const publicRepos: string[] = [];
  for (const repo of repos) {
    if (await isPublic(repo)) publicRepos.push(repo);
  }
  if (publicRepos.length > 0) {
    return {
      name: "public-repos",
      status: "warn",
      detail: `public repo(s) with label triggers: ${publicRepos.join(", ")}`,
      fix: "restrict factory:ready to private repos or lock allowedLabelers",
    };
  }
  return { name: "public-repos", status: "pass", detail: "no public repos detected" };
}

export async function probeSandboxLine(probe: () => Promise<SandboxProbe>): Promise<DoctorProbe> {
  const result = await probe();
  if (!result.available) {
    return {
      name: "sandbox",
      status: "fail",
      detail: result.detail,
      fix: "install sandbox-exec (macOS) or bwrap (Linux); lanes with sandbox: required will refuse to start",
    };
  }
  return { name: "sandbox", status: "pass", detail: result.detail };
}

export async function probeEnvScrub(run: () => Promise<{ leaked: string[] }>): Promise<DoctorProbe> {
  const { leaked } = await run();
  if (leaked.length > 0) {
    return {
      name: "env-scrub",
      status: "fail",
      detail: `leaked ${leaked.join(", ")}`,
      fix: "rebuild worker env via buildWorkerEnv; do not pass GITHUB_TOKEN/GH_TOKEN/SSH_AUTH_SOCK",
    };
  }
  return { name: "env-scrub", status: "pass", detail: "stripped credentials not visible in worker env" };
}

export async function probeChecks(repos: string[], home: string): Promise<DoctorProbe> {
  if (repos.length === 0) return { name: "checks", status: "warn", detail: "no registered repos", fix: "/factory setup <repo>" };
  const bad: string[] = [];
  for (const repo of repos) {
    try {
      const cfg = await loadEffectiveConfig(repo, { home });
      for (const check of cfg.repo.checks) {
        if (check.reporter !== "junit") bad.push(`${repo}: ${check.name} reporter=${check.reporter}`);
      }
    } catch (err) {
      bad.push(`${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (bad.length > 0) {
    return { name: "checks", status: "fail", detail: bad.join("; "), fix: "give every checks[] entry a junit reporter" };
  }
  return { name: "checks", status: "pass", detail: "checks declare machine-readable reporters" };
}

export async function probeConfig(repos: string[], home: string): Promise<DoctorProbe> {
  try {
    await readGlobal(home);
    for (const repo of repos) await loadEffectiveConfig(repo, { home });
    return { name: "config", status: "pass", detail: `loaded ${globalConfigPath(home)}` };
  } catch (err) {
    return {
      name: "config",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "/factory setup",
    };
  }
}

export function probeLanes(lanes: Record<string, LaneDef>): DoctorProbe {
  try {
    for (const [name, lane] of Object.entries(lanes)) {
      const named: NamedLane = { ...lane, name };
      compileLane(named, CATALOG, STUB_HOOKS);
    }
    return { name: "lanes", status: "pass", detail: `compiled ${Object.keys(lanes).join(", ") || "(none)"}` };
  } catch (err) {
    return {
      name: "lanes",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "fix lane YAML invariants and re-run /factory doctor",
    };
  }
}

export async function probeVaultLine(
  home: string,
  openVault: () => Promise<Vault>,
  secretRefs: string[],
): Promise<DoctorProbe> {
  try {
    const vault = await openVault();
    const names = new Set((await vault.list()).map((m) => m.name));
    const dangling = secretRefs
      .map((ref) => SECRET_REF.exec(ref)?.[1])
      .filter((name): name is string => name !== undefined && !names.has(name));
    if (dangling.length > 0) {
      return {
        name: "vault",
        status: "fail",
        detail: `dangling secret refs: ${dangling.join(", ")} (lanes that need secrets will not start)`,
        fix: "/factory secret set NAME --from-file <path>",
      };
    }
    return { name: "vault", status: "pass", detail: `openable (${names.size} secret(s))` };
  } catch (err) {
    const reason = err instanceof VaultUnavailableError ? err.message : err instanceof Error ? err.message : String(err);
    return {
      name: "vault",
      status: "fail",
      detail: reason,
      fix: "repair the OS keyring, then /factory secret set for any secret:NAME refs (lanes that need secrets will not start)",
    };
  }
}

export function probeDisk(homeBytes: number): DoctorProbe {
  const min = 256 * 1024 * 1024;
  if (homeBytes < min) {
    return {
      name: "disk",
      status: "fail",
      detail: `only ${homeBytes} bytes free under factory home`,
      fix: "/factory gc",
    };
  }
  return { name: "disk", status: "pass", detail: `${homeBytes} bytes free` };
}

export function probeLease(lease: { holder: boolean; ageSeconds: number; pid?: number }): DoctorProbe {
  if (!lease.holder) {
    return { name: "lease", status: "warn", detail: "this process is not the daemon lease holder", fix: "/factory start" };
  }
  return {
    name: "lease",
    status: "pass",
    detail: `holder pid ${lease.pid ?? process.pid}, age ${lease.ageSeconds}s`,
  };
}

export { probeSandbox };
