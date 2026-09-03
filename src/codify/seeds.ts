import { appendFile, mkdir, readFile, writeFile, access, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { matchesAny } from "../gate/glob.js";
import { appendLedger } from "../scheduler/ledger.js";
import type { SecretName } from "../vault/types.js";
import type { Vault } from "../vault/vault.js";

/** Interpreters whose invocation of a created file makes that file a script seed. */
export const SEED_INTERPRETERS: ReadonlySet<string> = new Set([
  "python",
  "python3",
  "uv",
  "node",
  "nodejs",
  "bash",
  "pwsh",
]);

export interface SeedRecord {
  runId: string;
  stage: string;
  n: number;
  trigger: "script-seed";
  scriptPath: string;
  commandLines: { argv: string[]; exitCode: number }[];
  filesRead: string[];
  envNames: string[];
  effect: { diff?: string; outputTail?: string };
  taskContextFenced: string;
  placeholders: SecretName[];
  wraps?: string;
  bindings?: Record<string, SecretName>;
  secretsBound?: boolean;
  /** Scrubbed script text the codifier may read; never vault plaintext. */
  scriptBody?: string;
}

export interface DetectSeedsInput {
  createdFiles: string[];
  commands: { argv: string[]; exitCode: number }[];
  declared: { path: string; purpose: string; inputsObserved: string[] }[];
}

export function seedPath(runsDir: string, runId: string, stage: string, n: number): string {
  return join(runsDir, "_factory", "codify", "seeds", `${runId}-${stage}-${n}.json`);
}

export function codifyInboxPath(runsDir: string): string {
  return join(runsDir, "_factory", "codify", "inbox.jsonl");
}

function binName(argv0: string | undefined): string {
  if (argv0 === undefined || argv0.length === 0) return "";
  return basename(argv0).replace(/\.exe$/i, "");
}

function commandUsesInterpreter(argv: string[]): boolean {
  if (argv.length === 0) return false;
  if (SEED_INTERPRETERS.has(binName(argv[0]))) return true;
  return argv.slice(1).some((a) => SEED_INTERPRETERS.has(binName(a)));
}

function argvHitsPath(argv: string[], filePath: string): boolean {
  const base = basename(filePath);
  return argv.some((a) => a === filePath || a.endsWith(`/${filePath}`) || basename(a) === base);
}

export function detectSeeds(input: DetectSeedsInput): { path: string; argv: string[] }[] {
  const hits: { path: string; argv: string[] }[] = [];
  const seen = new Set<string>();

  for (const file of input.createdFiles) {
    const matching = input.commands.find((c) => commandUsesInterpreter(c.argv) && argvHitsPath(c.argv, file));
    if (matching !== undefined && !seen.has(file)) {
      hits.push({ path: file, argv: matching.argv });
      seen.add(file);
    }
  }

  for (const declared of input.declared) {
    if (seen.has(declared.path)) continue;
    if (!input.createdFiles.includes(declared.path)) continue;
    const matching = input.commands.find((c) => commandUsesInterpreter(c.argv) && argvHitsPath(c.argv, declared.path));
    hits.push({ path: declared.path, argv: matching?.argv ?? ["python", declared.path] });
    seen.add(declared.path);
  }
  return hits;
}

const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function stripEnvFromArgv(argv: string[]): { argv: string[]; envNames: string[] } {
  const envNames: string[] = [];
  const out: string[] = [];
  for (const token of argv) {
    const assign = ENV_ASSIGN.exec(token);
    if (assign !== null && assign[1] !== undefined && !token.startsWith("-") && !token.includes("/")) {
      envNames.push(assign[1]);
      out.push(`${assign[1]}=`);
      continue;
    }
    const cleaned = token.replace(ENV_REF, (_whole, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      if (name.length > 0) envNames.push(name);
      return `$${name}`;
    });
    out.push(cleaned);
  }
  return { argv: out, envNames: [...new Set(envNames)] };
}

function fence(text: string): string {
  return `\`\`\`text\n${text.trim()}\n\`\`\``;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveScript(rel: string, workspaceDir: string, runDir: string): Promise<string | undefined> {
  for (const candidate of [join(workspaceDir, rel), join(runDir, rel), join(runDir, "scripts", basename(rel))]) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function knownVaultValues(vault: Vault): Promise<string[]> {
  const metas = await vault.list();
  const values: string[] = [];
  for (const meta of metas) {
    try {
      values.push(await vault.getPlaintext(meta.name));
    } catch {
      /* skip undecryptable rows */
    }
  }
  return values;
}

export interface SnapshotSeedInput {
  runsDir: string;
  runId: string;
  stage: string;
  n: number;
  scriptPath: string;
  commandLines: { argv: string[]; exitCode: number }[];
  filesRead: string[];
  envNames: string[];
  effect: { diff?: string; outputTail?: string };
  taskContextFenced: string;
  workspaceDir: string;
  runDir: string;
  writeRoots: string[];
  vault?: Vault;
  scriptBody?: string;
}

export async function snapshotSeed(input: SnapshotSeedInput): Promise<SeedRecord> {
  const envNames = new Set(input.envNames);
  const commandLines = input.commandLines.map((line) => {
    const stripped = stripEnvFromArgv(line.argv);
    for (const name of stripped.envNames) envNames.add(name);
    return { argv: stripped.argv, exitCode: line.exitCode };
  });

  let body = input.scriptBody;
  if (body === undefined) {
    const abs = (await resolveScript(input.scriptPath, input.workspaceDir, input.runDir)) ?? join(input.workspaceDir, input.scriptPath);
    body = await readFile(abs, "utf8");
  }

  let placeholders: SecretName[] = [];
  try {
    const { scrubSeed } = await import("../vault/scrub.js");
    const values = input.vault !== undefined ? await knownVaultValues(input.vault) : [];
    const result = scrubSeed(body, values);
    if (result.ok) {
      body = result.text;
      placeholders = result.placeholders;
    }
  } catch {
    /* scrub.ts lands in Task 3.2 */
  }

  const inWorkspace = await exists(join(input.workspaceDir, input.scriptPath));
  const rec: SeedRecord = {
    runId: input.runId,
    stage: input.stage,
    n: input.n,
    trigger: "script-seed",
    scriptPath: input.scriptPath.replaceAll("\\", "/"),
    commandLines,
    filesRead: input.filesRead,
    envNames: [...envNames],
    effect: input.effect,
    taskContextFenced: input.taskContextFenced,
    placeholders,
    scriptBody: body,
  };
  if (inWorkspace && matchesAny(input.scriptPath, input.writeRoots)) {
    rec.wraps = rec.scriptPath;
  }

  const path = seedPath(input.runsDir, input.runId, input.stage, input.n);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(rec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return rec;
}

export async function appendCodifyInbox(runsDir: string, rec: Record<string, unknown>): Promise<void> {
  const path = codifyInboxPath(runsDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(rec)}\n`, { encoding: "utf8", mode: 0o600 });
}

export interface MaybeSeedInput {
  runsDir: string;
  runId: string;
  stage: string;
  workspaceDir: string;
  runDir: string;
  writeRoots: string[];
  createdFiles: string[];
  commands: { argv: string[]; exitCode: number }[];
  declared: { path: string; purpose: string; inputsObserved: string[] }[];
  effect?: { diff?: string; outputTail?: string };
  taskContext?: string;
  vault?: Vault;
}

export async function listScriptFiles(dir: string, prefix: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.map((name) => `${prefix}/${name}`);
  } catch {
    return [];
  }
}

export async function maybeSeed(input: MaybeSeedInput): Promise<SeedRecord[]> {
  const existing: string[] = [];
  for (const file of input.createdFiles) {
    if ((await resolveScript(file, input.workspaceDir, input.runDir)) !== undefined) existing.push(file);
  }
  for (const declared of input.declared) {
    if (!existing.includes(declared.path) && (await resolveScript(declared.path, input.workspaceDir, input.runDir)) !== undefined) {
      existing.push(declared.path);
    }
  }
  const hits = detectSeeds({
    createdFiles: existing,
    commands: input.commands,
    declared: input.declared,
  });
  const out: SeedRecord[] = [];
  let n = 0;
  for (const hit of hits) {
    const cmd = input.commands.filter((c) => argvHitsPath(c.argv, hit.path));
    const declared = input.declared.find((d) => d.path === hit.path);
    const rec = await snapshotSeed({
      runsDir: input.runsDir,
      runId: input.runId,
      stage: input.stage,
      n,
      scriptPath: hit.path,
      commandLines: cmd.length > 0 ? cmd : [{ argv: hit.argv, exitCode: 0 }],
      filesRead: declared?.inputsObserved ?? [],
      envNames: [],
      effect: input.effect ?? {},
      taskContextFenced: fence(input.taskContext ?? ""),
      workspaceDir: input.workspaceDir,
      runDir: input.runDir,
      writeRoots: input.writeRoots,
      ...(input.vault === undefined ? {} : { vault: input.vault }),
    });
    await appendCodifyInbox(input.runsDir, {
      trigger: "script-seed",
      priority: -5,
      runId: input.runId,
      stage: input.stage,
      n,
      seed: seedPath(input.runsDir, input.runId, input.stage, n),
      at: new Date().toISOString(),
    });
    out.push(rec);
    n += 1;
  }
  return out;
}

const WRITER_AGENTS = new Set(["implementer", "tester"]);

export function isSeedWriterAgent(name: string | undefined): boolean {
  return name !== undefined && WRITER_AGENTS.has(name);
}

/** Catch seeding failures so a writer stage still PASSes; ledger `code: seed-failed`. */
export async function seedAfterWriterStage(input: MaybeSeedInput): Promise<SeedRecord[]> {
  try {
    return await maybeSeed(input);
  } catch (err) {
    try {
      await appendLedger(input.runsDir, {
        ts: new Date().toISOString(),
        type: "codify.seed",
        code: "seed-failed",
        key: input.runId,
      });
    } catch {
      /* ledger is best-effort beside a seed failure */
    }
    void err;
    return [];
  }
}
