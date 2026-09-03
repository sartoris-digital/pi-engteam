import { assertSecretName, Vault } from "./vault.js";

export const SECRET_REF = /^secret:((?:repo\/[^/]+\/)?[A-Z][A-Z0-9_]+)$/;

export async function resolveSecretRef(ref: string, vault: Vault, repoSlug?: string): Promise<string> {
  const match = SECRET_REF.exec(ref);
  if (match === null || match[1] === undefined) {
    throw new Error(`invalid secret ref: ${JSON.stringify(ref)} (expected secret:<NAME> or secret:repo/<slug>/<NAME>)`);
  }
  const name = match[1];
  if (name.startsWith("repo/")) {
    assertSecretName(name);
    return vault.getPlaintext(name);
  }
  if (repoSlug !== undefined && repoSlug.length > 0) {
    const scoped = `repo/${repoSlug}/${name}`;
    try {
      assertSecretName(scoped);
      return await vault.getPlaintext(scoped);
    } catch (err) {
      if (err instanceof Error && /not found/.test(err.message)) {
        // fall through to the global name
      } else {
        throw err;
      }
    }
  }
  assertSecretName(name);
  return vault.getPlaintext(name);
}
