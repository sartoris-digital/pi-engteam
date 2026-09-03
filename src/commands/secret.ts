import { readFile } from "node:fs/promises";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { Vault } from "../vault/vault.js";
import type { ParsedFactoryArgs } from "./router.js";

const V1_VERBS = new Set(["set", "list", "rm", "rotate"]);
const RETIRED = new Set(["export", "import", "scrub", "bind"]);

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

async function vaultOf(deps: FactoryDeps): Promise<Vault> {
  if (deps.vault !== undefined) return deps.vault;
  return Vault.open({ home: deps.home });
}

async function readValue(parsed: ParsedFactoryArgs): Promise<{ value: string; warning?: string }> {
  const fromFile = flagString(parsed.flags, "from-file");
  if (fromFile !== undefined) return { value: await readFile(fromFile, "utf8") };
  const fromEnv = flagString(parsed.flags, "from-env");
  if (fromEnv !== undefined) {
    const value = process.env[fromEnv];
    if (value === undefined || value.length === 0) throw new Error(`secret: env ${fromEnv} is empty`);
    return { value, warning: `copied $${fromEnv}; unset it in the parent shell` };
  }
  const direct = flagString(parsed.flags, "value");
  if (direct !== undefined) return { value: direct, warning: "secret set --value is visible in argv; prefer --from-file" };
  throw new Error("secret: provide --from-file, --from-env, or --value");
}

export async function runSecret(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<string> {
  const verb = parsed.args[0];
  if (verb === undefined) throw new Error("secret: set|list|rm|rotate required");
  if (RETIRED.has(verb)) throw new Error(`secret ${verb} is not in v1`);
  if (!V1_VERBS.has(verb)) throw new Error(`secret: unknown verb ${verb}`);
  const vault = await vaultOf(deps);
  if (verb === "list") {
    const rows = await vault.list();
    if (rows.length === 0) return "no secrets";
    return rows.map((m) => [m.name, m.createdAt, m.rotatedAt ?? "", m.note ?? ""].join("\t")).join("\n");
  }
  const name = parsed.args[1];
  if (name === undefined || name.length === 0) throw new Error(`secret ${verb}: name required`);
  if (verb === "rm") {
    if (parsed.flags.yes !== true) throw new Error("secret rm requires --yes");
    await vault.rm(name, { yes: true });
    return `removed ${name}`;
  }
  const { value, warning } = await readValue(parsed);
  if (verb === "rotate") {
    const meta = await vault.rotate(name, value);
    return warning === undefined ? `rotated ${meta.name}` : `rotated ${meta.name} (${warning})`;
  }
  const note = flagString(parsed.flags, "note");
  const meta = await vault.set(name, value, note === undefined ? undefined : { note });
  return warning === undefined ? `set ${meta.name}` : `set ${meta.name} (${warning})`;
}
