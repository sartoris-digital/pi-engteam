/** Copy parent env and overlay host-only secrets. Never used by buildWorkerEnv. */
export function injectHostEnv(base: NodeJS.ProcessEnv, secrets: Record<string, string>): NodeJS.ProcessEnv {
  return { ...base, ...secrets };
}
