export type DeclaredSecret = {
  name: string;
  env_var: string;
  required: boolean;
};

export type SecretsManifest = {
  name: string;
  secrets: DeclaredSecret[];
};

export type ManifestValidationResult =
  | { ok: true; parsed: SecretsManifest }
  | { ok: false; errors: string[] };

export function validateManifest(input: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (!input || typeof input !== "object") {
    errors.push("manifest must be an object");
    return { ok: false, errors };
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name === "") {
    errors.push("name is required and must be a non-empty string");
  }

  if (!Array.isArray(obj.secrets)) {
    errors.push("secrets must be an array");
  } else {
    for (let i = 0; i < obj.secrets.length; i++) {
      const secret = obj.secrets[i];

      if (!secret || typeof secret !== "object") {
        errors.push(`secrets[${i}] must be an object`);
        continue;
      }

      const sec = secret as Record<string, unknown>;

      if (typeof sec.name !== "string" || sec.name === "") {
        errors.push(`secrets[${i}].name is required and must be a non-empty string`);
      }

      if (typeof sec.env_var !== "string" || sec.env_var === "") {
        errors.push(`secrets[${i}].env_var is required and must be a non-empty string`);
      }

      if (typeof sec.required !== "boolean") {
        errors.push(`secrets[${i}].required must be a boolean`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    parsed: {
      name: obj.name as string,
      secrets: obj.secrets as DeclaredSecret[],
    },
  };
}

export function checkRequiredSecrets(
  manifest: SecretsManifest,
  vaultNames: string[]
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const vaultSet = new Set(vaultNames);

  for (const secret of manifest.secrets) {
    if (secret.required && !vaultSet.has(secret.name)) {
      missing.push(secret.name);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}
