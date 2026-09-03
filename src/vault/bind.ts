import { readFile, writeFile } from "node:fs/promises";
import type { SeedRecord } from "../codify/seeds.js";
import type { SecretName } from "./types.js";
import { assertSecretName, type Vault } from "./vault.js";

export function asSecretName(raw: string): SecretName {
  return (raw.startsWith("secret:") ? raw : `secret:${raw}`) as SecretName;
}

export function vaultNameOf(ref: string): string {
  return ref.startsWith("secret:") ? ref.slice("secret:".length) : ref;
}

export function secretsBound(seed: Pick<SeedRecord, "placeholders" | "bindings">): boolean {
  const bindings = seed.bindings ?? {};
  return seed.placeholders.every((p) => bindings[p] !== undefined);
}

export interface BindRequest {
  seedPath: string;
  placeholder: SecretName | string;
  to?: SecretName | string;
  set?: { name: SecretName | string; value: string };
  vault: Vault;
}

export interface BindResult {
  secretsBound: boolean;
  bindings: Record<string, SecretName>;
}

function pendingManifestPath(seedPath: string): string {
  return seedPath.replace(/\.json$/i, ".manifest.json");
}

export async function bindSecret(req: BindRequest): Promise<BindResult> {
  const placeholder = asSecretName(req.placeholder);
  let target: SecretName;
  if (req.set !== undefined) {
    target = asSecretName(req.set.name);
    assertSecretName(vaultNameOf(target));
    await req.vault.set(vaultNameOf(target), req.set.value);
  } else if (req.to !== undefined) {
    target = asSecretName(req.to);
    assertSecretName(vaultNameOf(target));
    await req.vault.getPlaintext(vaultNameOf(target));
  } else {
    throw new Error("secret bind: provide --to <name> or --set");
  }

  const seed = JSON.parse(await readFile(req.seedPath, "utf8")) as SeedRecord;
  const bindings = { ...(seed.bindings ?? {}), [placeholder]: target };
  seed.bindings = bindings;
  seed.secretsBound = secretsBound(seed);
  await writeFile(req.seedPath, `${JSON.stringify(seed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const secrets = [...new Set(Object.values(bindings))];
  const manifest = {
    secrets,
    secretsBound: seed.secretsBound,
    bindings,
  };
  await writeFile(pendingManifestPath(req.seedPath), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { secretsBound: seed.secretsBound === true, bindings };
}
