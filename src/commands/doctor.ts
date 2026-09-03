import { readFile } from "node:fs/promises";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { probeSandbox } from "../runtime/sandbox.js";
import { SECRET_REF } from "../vault/resolve.js";
import { Vault } from "../vault/vault.js";
import {
  metricsFromLedger,
  probeAdapters,
  probeChecks,
  probeConfig,
  probeDisk,
  probeEnvScrub,
  probeLanes,
  probeLease,
  probePublicRepos,
  probeSandboxLine,
  probeVaultLine,
  readDoctorLedger,
  type DoctorInjects,
  type DoctorMetrics,
  type DoctorProbe,
} from "../setup/doctor-probes.js";
import { globalConfigPath } from "../config/layers.js";
import type { ParsedFactoryArgs } from "./router.js";

export type { DoctorMetrics, DoctorProbe };

export interface DoctorReport {
  probes: DoctorProbe[];
  metrics: DoctorMetrics;
  candidates: string[];
}

export interface DoctorOptions extends DoctorInjects {
  structured?: boolean;
}

function collectSecretRefs(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (SECRET_REF.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretRefs(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) collectSecretRefs(child, out);
  }
}

async function secretRefsInHome(home: string): Promise<string[]> {
  const out: string[] = [];
  try {
    collectSecretRefs(JSON.parse(await readFile(globalConfigPath(home), "utf8")), out);
  } catch {
    /* no global file */
  }
  return out;
}

function formatReport(report: DoctorReport): string {
  const lines = ["# factory doctor", "", "## probes"];
  for (const p of report.probes) {
    const fix = p.fix === undefined ? "" : ` (fix: ${p.fix})`;
    lines.push(`- ${p.name}: ${p.status} — ${p.detail}${fix}`);
  }
  if (report.candidates.length > 0) {
    lines.push("", "## tracker candidates (not enabled)", ...report.candidates.map((c) => `- ${c}`));
  }
  lines.push(
    "",
    "## metrics",
    `- abstentionRate: ${report.metrics.abstentionRate}`,
    `- landedAs: clean=${report.metrics.landedAs.clean} human-modified=${report.metrics.landedAs["human-modified"]} partial=${report.metrics.landedAs.partial} closed=${report.metrics.landedAs.closed}`,
    `- escalations: ${Object.keys(report.metrics.escalations).length === 0 ? "(none)" : JSON.stringify(report.metrics.escalations)}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function collectDoctorReport(deps: FactoryDeps, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const adapters = [...(deps.adapters?.values() ?? [deps.tracker])];
  const detect = opts.detect ?? ((adapter) => adapter.detect());
  const isPublic = opts.isPublic ?? (async () => false);
  const sandbox = opts.probeSandbox ?? probeSandbox;
  const envScrub = opts.envScrub ?? (async () => ({ leaked: [] as string[] }));
  const openVault =
    opts.openVault ??
    (async () => {
      if (deps.vault !== undefined) return deps.vault;
      return Vault.open({ home: deps.home });
    });
  const refs = await secretRefsInHome(deps.home);
  const probes: DoctorProbe[] = [
    await probeAdapters(adapters, detect),
    await probePublicRepos(deps.repos, isPublic),
    await probeSandboxLine(sandbox),
    await probeEnvScrub(envScrub),
    await probeChecks(deps.repos, deps.home),
    await probeConfig(deps.repos, deps.home),
    probeLanes(deps.lanes),
    await probeVaultLine(deps.home, openVault, refs),
    probeDisk((await (opts.diskFree ?? (async () => ({ homeBytes: 1_000_000_000 })))()).homeBytes),
    probeLease(opts.lease ?? { holder: true, ageSeconds: 0, pid: process.pid }),
  ];
  const events = await readDoctorLedger(deps.runsDir, opts.since);
  return {
    probes,
    metrics: metricsFromLedger(events),
    candidates: ["azure-devops (skills/factory-azure-devops)", "jira (skills/factory-jira)"],
  };
}

export async function runDoctor(
  deps: FactoryDeps,
  opts: DoctorOptions | ParsedFactoryArgs = {},
): Promise<string | DoctorReport> {
  const options: DoctorOptions = "verb" in opts ? { since: typeof opts.flags.since === "string" ? new Date(opts.flags.since) : undefined } : opts;
  const report = await collectDoctorReport(deps, options);
  if (options.structured === true) return report;
  return formatReport(report);
}
