// Phase A runtime hooks. Called by ADWEngine.startRun() to perform
// per-run capability gating and emit Phase A telemetry events. Kept
// out of ADWEngine.ts to minimize the surface there and to make
// these checks individually testable.
import { execSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { CapabilityMatrix, type CapabilityMode, type LookupKey } from "./capability-matrix.js";
import { getPhaseAConfig } from "./phaseA-config.js";

export type RuntimeFingerprint = {
  provider: string;
  modelId: string;
  accountFingerprint: string;
  piVersion: string;
  piBuildHash: string;
  protocolVersion: string;
  runtimeFlags: string[];
};

/**
 * Resolve the current Pi binary's version + a stable build-hash. The
 * build hash is sha256 of the realpath-resolved binary contents so a
 * PATH swap / symlink change is detected at the next subprocess
 * spawn (PLAN item E9).
 */
export function resolvePiBinaryFingerprint(piBinary = "pi"): { piVersion: string; piBuildHash: string; binaryPath: string } {
  let piVersion = "unknown";
  let piBuildHash = "unknown";
  let binaryPath = piBinary;
  try {
    const out = execSync(`${piBinary} --version`, { encoding: "utf8", timeout: 5000 });
    const m = out.trim().match(/(\d+\.\d+\.\d+\S*)/);
    if (m) piVersion = m[1];
  } catch {
    // Pi may not be on PATH in dev/test; leave as "unknown".
  }
  try {
    const which = execSync(`command -v ${piBinary}`, { encoding: "utf8", timeout: 2000 }).trim();
    if (which) {
      binaryPath = which;
      const buf = readFileSync(which);
      piBuildHash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    }
  } catch {
    // ignore
  }
  return { piVersion, piBuildHash, binaryPath };
}

/**
 * Compose a runtime fingerprint from environment + Pi binary info.
 * Caller supplies `provider`/`modelId`/`accountFingerprint` — these
 * come from the workflow/agent config; we don't try to introspect
 * Pi's own config from here.
 */
export function buildRuntimeFingerprint(input: {
  provider?: string;
  modelId?: string;
  accountFingerprint?: string;
  protocolVersion?: string;
  runtimeFlags?: string[];
}): RuntimeFingerprint {
  const { piVersion, piBuildHash } = resolvePiBinaryFingerprint();
  return {
    provider: input.provider ?? process.env.PI_ENGINEERING_PROVIDER ?? "unknown",
    modelId: input.modelId ?? process.env.PI_ENGINEERING_MODEL ?? "unknown",
    accountFingerprint: input.accountFingerprint ?? process.env.PI_ENGINEERING_ACCOUNT_FINGERPRINT ?? "unknown",
    piVersion,
    piBuildHash,
    protocolVersion: input.protocolVersion ?? process.env.PI_ENGINEERING_PROTOCOL_VERSION ?? "auto",
    runtimeFlags: input.runtimeFlags ?? [],
  };
}

export type CapabilityCheckResult =
  | { allowed: true; source: "probed" | "baseline" | "legacy-bypass"; matchedByWildcard: boolean; ageDays?: number }
  | { allowed: false; reason: string; mode: CapabilityMode };

/**
 * Run the capability check at run start. Behavior:
 *   - LEGACY_MODE: bypass entirely, return { allowed: true,
 *     source: "legacy-bypass" }.
 *   - `observe`: log + always allow.
 *   - `warn`: log on mismatch/staleness/missing-tool but always
 *     allow.
 *   - `enforce`: refuse if no concrete probed bundle matches.
 */
export function performCapabilityCheck(
  matrix: CapabilityMatrix,
  fp: RuntimeFingerprint,
  logger: { warn: (msg: string) => void; error: (msg: string) => void } = console,
): CapabilityCheckResult {
  const config = getPhaseAConfig();
  if (config.legacyMode) {
    return { allowed: true, source: "legacy-bypass", matchedByWildcard: false };
  }
  const key: LookupKey = {
    provider: fp.provider,
    modelId: fp.modelId,
    accountFingerprint: fp.accountFingerprint,
    piVersion: fp.piVersion,
    piBuildHash: fp.piBuildHash,
    protocolVersion: fp.protocolVersion,
    runtimeFlags: fp.runtimeFlags,
  };
  const lookup = matrix.getCapabilities(key);
  if (!lookup) {
    if (config.capabilityMode === "enforce") {
      return {
        allowed: false,
        mode: config.capabilityMode,
        reason: `provider-missing-capability: no capability bundle matched runtime fingerprint ${JSON.stringify(key)}. Run \`pnpm probe-pi-provider --provider ${fp.provider} --model ${fp.modelId}\` to seed one.`,
      };
    }
    logger.warn(
      `[pi-team] capability check: no bundle matched ${fp.provider}/${fp.modelId} on ${fp.piVersion}/${fp.piBuildHash}; proceeding in ${config.capabilityMode} mode.`,
    );
    return { allowed: true, source: "baseline", matchedByWildcard: true };
  }
  if (lookup.source === "baseline" && config.capabilityMode === "enforce") {
    return {
      allowed: false,
      mode: config.capabilityMode,
      reason: `provider-missing-capability: only a baseline (wildcard) bundle matched ${fp.provider} — enforce mode requires a probed per-account bundle. Run \`pnpm probe-pi-provider --provider ${fp.provider} --model ${fp.modelId}\`.`,
    };
  }
  if (lookup.matchedByWildcard) {
    logger.warn(
      `[pi-team] capability check: matched ${lookup.source} bundle by wildcard for ${fp.provider}/${fp.modelId}.`,
    );
  }
  return {
    allowed: true,
    source: lookup.source,
    matchedByWildcard: lookup.matchedByWildcard,
    ageDays: lookup.age.ageDays,
  };
}

/**
 * Convenience constructor used by ADWEngine — instantiates the
 * matrix with the Phase A config's capability mode.
 */
export function makeCapabilityMatrix(): CapabilityMatrix {
  return new CapabilityMatrix({ mode: getPhaseAConfig().capabilityMode });
}

/**
 * Phase A item 5: typed step-timeout error. ADWEngine catches and
 * converts to a FAIL verdict with a clear message.
 */
export class StepTimeoutError extends Error {
  readonly stepName: string;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  constructor(stepName: string, elapsedMs: number, budgetMs: number) {
    super(`step '${stepName}' exceeded timeout budget of ${budgetMs}ms (elapsed ${elapsedMs}ms)`);
    this.name = "StepTimeoutError";
    this.stepName = stepName;
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
  }
}

/**
 * Default per-step timeout in seconds. Judge-gate steps get a longer
 * default; everything else gets 240s.
 */
export function defaultStepTimeoutSeconds(stepName: string): number {
  if (stepName === "judge-gate") return 360;
  return 240;
}

/**
 * Run `fn()` against an absolute deadline. The promise resolves with
 * the function's result OR rejects with `StepTimeoutError`. Does NOT
 * abort the underlying work — the worker subprocess may still be
 * running. ADWEngine handles cancellation/cleanup downstream.
 */
export async function runWithStepTimeout<T>(
  stepName: string,
  timeoutSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const budgetMs = Math.max(1000, Math.floor(timeoutSeconds * 1000));
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new StepTimeoutError(stepName, Date.now() - start, budgetMs));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
