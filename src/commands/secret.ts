import { readFile, writeFile } from "node:fs/promises";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { bindSecret } from "../vault/bind.js";
import { exportVault, importVault, type ExportEnvelope } from "../vault/export.js";
import { scrubFile } from "../vault/scrub.js";
import { Vault } from "../vault/vault.js";
import type { ParsedFactoryArgs } from "./router.js";

const V1_VERBS = new Set(["set", "list", "rm", "rotate"]);
const V15_VERBS = new Set(["bind", "export", "import", "scrub"]);

export interface SecretCommandUi {
  input: (title: string, placeholder?: string) => Promise<string>;
}

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

async function readPassphrase(parsed: ParsedFactoryArgs, ui: SecretCommandUi | undefined): Promise<string> {
  const fromFile = flagString(parsed.flags, "passphrase-from-file");
  if (fromFile !== undefined) return (await readFile(fromFile, "utf8")).replace(/\n+$/, "");
  if (ui !== undefined) return ui.input("Vault passphrase", "");
  throw new Error("secret: provide --passphrase-from-file or an interactive session");
}

export async function runSecret(
  parsed: ParsedFactoryArgs,
  deps: FactoryDeps,
  ui?: SecretCommandUi,
): Promise<string> {
  const verb = parsed.args[0];
  if (verb === undefined) throw new Error("secret: set|list|rm|rotate|bind|export|import|scrub required");
  if (!V1_VERBS.has(verb) && !V15_VERBS.has(verb)) throw new Error(`secret: unknown verb ${verb}`);
  const vault = await vaultOf(deps);

  if (verb === "list") {
    const rows = await vault.list();
    if (rows.length === 0) return "no secrets";
    return rows.map((m) => [m.name, m.createdAt, m.rotatedAt ?? "", m.note ?? ""].join("\t")).join("\n");
  }

  if (verb === "bind") {
    const placeholder = parsed.args[1];
    if (placeholder === undefined || placeholder.length === 0) throw new Error("secret bind: placeholder required");
    const seedPath = flagString(parsed.flags, "seed");
    if (seedPath === undefined) throw new Error("secret bind: --seed <path> required");
    const to = flagString(parsed.flags, "to");
    if (parsed.flags.set === true) {
      const { value } = await readValue(parsed);
      const name = to ?? placeholder;
      const result = await bindSecret({ seedPath, placeholder, set: { name, value }, vault });
      return `bound ${placeholder} → ${name} (secretsBound=${String(result.secretsBound)})`;
    }
    if (to === undefined) throw new Error("secret bind: --to <name> required");
    const result = await bindSecret({ seedPath, placeholder, to, vault });
    return `bound ${placeholder} → ${to} (secretsBound=${String(result.secretsBound)})`;
  }

  if (verb === "export") {
    const path = parsed.args[1];
    if (path === undefined || path.length === 0) throw new Error("secret export: path required");
    const passphrase = await readPassphrase(parsed, ui);
    const envelope = await exportVault(vault, passphrase);
    await writeFile(path, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    return `exported ${envelope.names.length} secret(s) to ${path}`;
  }

  if (verb === "import") {
    const path = parsed.args[1];
    if (path === undefined || path.length === 0) throw new Error("secret import: path required");
    const passphrase = await readPassphrase(parsed, ui);
    const envelope = JSON.parse(await readFile(path, "utf8")) as ExportEnvelope;
    const names = await importVault(vault, envelope, passphrase);
    return `imported ${names.join(", ")}`;
  }

  if (verb === "scrub") {
    const path = parsed.args[1];
    if (path === undefined || path.length === 0) throw new Error("secret scrub: path required");
    const { hits } = await scrubFile(path, vault);
    return hits === 0 ? `scrubbed ${path}: 0 hits` : `scrubbed ${path}: ${hits} hit(s)`;
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
