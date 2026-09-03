import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { matchesAny } from "../gate/glob.js";
import { sealedDir, sealedFixtureDir } from "./layout.js";
import { transition, type Registry, type RegistryEntry } from "./registry.js";

export type DriftTrigger =
  | "sha-mismatch"
  | "smoke-fail"
  | "precondition-streak"
  | "write-globs-outside-roots"
  | "major-tooling-bump";

export interface DriftInput {
  executingSha256: string;
  registrySha256: string;
  smoke?: { exitCode: number; applyOk?: boolean; checksRed?: boolean };
  preconditionStreak: number;
  writeGlobs: string[];
  writeRoots: string[];
  uvVersion?: string;
  formatterVersion?: string;
  validation: { uvVersion?: string; formatterVersion?: string };
}

export function detectDrift(input: DriftInput): { drifted: boolean; trigger?: DriftTrigger } {
  if (input.executingSha256 !== input.registrySha256) return { drifted: true, trigger: "sha-mismatch" };
  const smoke = input.smoke;
  if (smoke && (smoke.exitCode === 3 || smoke.applyOk === false || smoke.checksRed === true)) {
    return { drifted: true, trigger: "smoke-fail" };
  }
  if (input.preconditionStreak >= 3) return { drifted: true, trigger: "precondition-streak" };
  if (input.writeGlobs.some((g) => !matchesAny(g, input.writeRoots))) {
    return { drifted: true, trigger: "write-globs-outside-roots" };
  }
  if (majorBump(input.validation.uvVersion, input.uvVersion) || majorBump(input.validation.formatterVersion, input.formatterVersion)) {
    return { drifted: true, trigger: "major-tooling-bump" };
  }
  return { drifted: false };
}

function major(version: string): number | undefined {
  const m = /^v?(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}

function majorBump(from?: string, to?: string): boolean {
  if (from === undefined || to === undefined) return false;
  const a = major(from);
  const b = major(to);
  if (a === undefined || b === undefined) return false;
  return b > a;
}

export function applyDrift(reg: Registry, name: string, trigger: DriftTrigger, now: Date = new Date()): Registry {
  return transition(reg, name, "drifted", "system", trigger, now);
}

export function onSourceMemberReverted(entry: RegistryEntry, now: Date = new Date()): RegistryEntry {
  const next = transition({ entries: { [entry.name]: entry }, rejected: {} }, entry.name, "probationary", "system", "survival-reverted", now);
  return next.entries[entry.name] ?? entry;
}

export function retryFailingCase(opts: {
  toolPy: string;
  failing: { input: unknown; expectedPatch: string };
  revalidate: (fixture: { input: unknown; expectedPatch: string }) => { ok: boolean };
}): {
  sealedFixture: { input: unknown; expectedPatch: string };
  toolPy: string;
  enqueueRepair: boolean;
} {
  const sealedFixture = { input: opts.failing.input, expectedPatch: opts.failing.expectedPatch };
  return {
    sealedFixture,
    toolPy: opts.toolPy,
    enqueueRepair: !opts.revalidate(sealedFixture).ok,
  };
}

export async function appendSealedRetryFixture(opts: {
  home: string;
  name: string;
  input: unknown;
  expectedPatch: string;
}): Promise<string> {
  const root = sealedDir(opts.home, opts.name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const existing = await readdir(root).catch(() => [] as string[]);
  let max = -1;
  for (const name of existing) {
    const n = Number(name);
    if (Number.isInteger(n) && n > max) max = n;
  }
  const dest = sealedFixtureDir(opts.home, opts.name, max + 1);
  await mkdir(dest, { recursive: true, mode: 0o700 });
  await writeFile(join(dest, "input.json"), `${JSON.stringify(opts.input, null, 2)}\n`, "utf8");
  await writeFile(join(dest, "expected.patch"), opts.expectedPatch, "utf8");
  return dest;
}
