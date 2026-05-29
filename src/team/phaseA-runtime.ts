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
 * Phase C item 20: PI version detection at boot. Parses
 * `pi --version` once, returns a structured comparison result.
 *
 * Floors:
 *   - < 0.65 → HARD FAIL (peer-dep floor; subprocess flow won't work).
 *   - < 0.73 → WARN (GHCP-subprocess gaps known to be open).
 *   - >= 0.73 → OK.
 *
 * Returns `{ piVersion, ok, level, message }`. Caller decides
 * whether to throw on level==="error".
 */
export type PiVersionCheck = {
  piVersion: string;
  level: "ok" | "warn" | "error" | "unknown";
  message: string;
};

let cachedVersionCheck: PiVersionCheck | undefined;

export function checkPiVersion(piBinary = "pi"): PiVersionCheck {
  if (cachedVersionCheck) return cachedVersionCheck;
  const { piVersion } = resolvePiBinaryFingerprint(piBinary);
  if (piVersion === "unknown") {
    cachedVersionCheck = {
      piVersion,
      level: "unknown",
      message: `could not detect 'pi --version'. Phase A/B behaviors that depend on Pi subprocess routing may not work as expected.`,
    };
    return cachedVersionCheck;
  }
  const cmp = compareSemver(piVersion);
  if (cmp.major === 0 && cmp.minor < 65) {
    cachedVersionCheck = {
      piVersion,
      // NOTE: this message keeps the `pi-engineering:` self-prefix because the
      // "error" level is THROWN (ADWEngine re-throws it) without the
      // `[pi-engineering]` console wrapper that labels the warn/unknown levels.
      level: "error",
      message: `pi-engineering: detected pi ${piVersion} which is below the 0.65 peer-dep floor. Upgrade pi-cli to >= 0.73 before continuing.`,
    };
  } else if (cmp.major === 0 && cmp.minor < 73) {
    cachedVersionCheck = {
      piVersion,
      level: "warn",
      message: `detected pi ${piVersion}. The CoPilot-compat fixes shipped in pi-engineering 2.0.11-2.0.15 + 2.1.x rely on pi-cli >= 0.73 for stable subprocess routing. Consider upgrading.`,
    };
  } else {
    cachedVersionCheck = {
      piVersion,
      level: "ok",
      message: `pi ${piVersion} OK.`,
    };
  }
  return cachedVersionCheck;
}

/** Test-only — clears the cached version check so the next call re-reads. */
export function resetPiVersionCheckCache(): void {
  cachedVersionCheck = undefined;
}

function compareSemver(v: string): { major: number; minor: number; patch: number } {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { major: 0, minor: 0, patch: 0 };
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

/**
 * Phase E item E9 — per-spawn capability re-check. Computes a
 * lightweight runtime fingerprint hash and compares it against
 * the matched capability bundle's recorded fingerprint. Detects
 * `pi` binary swap, PATH change, build-hash drift, etc.
 *
 * Returns:
 *   - { match: true } when everything still matches.
 *   - { match: false, reason } on mismatch. Caller's mode (from
 *     getPhaseAConfig().capabilityMode) determines whether to
 *     proceed (warn/observe) or refuse (enforce).
 */
export type SpawnRecheckResult =
  | { match: true; fingerprint: string }
  | { match: false; reason: string; fingerprint: string; expectedFingerprint: string };

import { createHash as _createHash } from "crypto";

/**
 * Compute a stable runtime fingerprint hash. Includes the
 * resolved `pi` binary path, version, build hash, account, model,
 * protocol version, and sorted runtime flags. Suitable for
 * cheap comparison every spawn (≈10ms — most of which is the
 * pi-version exec on a cold call; subsequent calls hit the
 * cache in resolvePiBinaryFingerprint).
 */
export function computeRuntimeFingerprintHash(fp: RuntimeFingerprint, binaryPath?: string): string {
  const parts = [
    binaryPath ?? "",
    fp.provider,
    fp.modelId,
    fp.accountFingerprint,
    fp.piVersion,
    fp.piBuildHash,
    fp.protocolVersion,
    [...fp.runtimeFlags].sort().join(","),
  ];
  return _createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/**
 * Per-spawn check. Caller supplies the expected fingerprint hash
 * recorded at runStart; this re-computes the current hash and
 * decides whether to allow the spawn.
 *
 * In enforce mode the caller should re-probe (cached for 5min)
 * on mismatch before refusing — that's done at a higher layer.
 * This helper just signals the comparison result.
 */
export function recheckSpawn(
  expectedFingerprint: string,
  current: RuntimeFingerprint,
  binaryPath?: string,
): SpawnRecheckResult {
  const fingerprint = computeRuntimeFingerprintHash(current, binaryPath);
  if (fingerprint === expectedFingerprint) {
    return { match: true, fingerprint };
  }
  return {
    match: false,
    fingerprint,
    expectedFingerprint,
    reason: `runtime fingerprint changed since run start (was ${expectedFingerprint.slice(0, 8)}…, now ${fingerprint.slice(0, 8)}…)`,
  };
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
 * Default per-step timeout in seconds. All steps get 1800s for GHCP
 * compatibility — GHCP inference latency after complex tool-call sequences
 * can exceed 12 minutes for synthesis-heavy steps (audit, write-tests, etc.).
 */
export function defaultStepTimeoutSeconds(_stepName: string): number {
  return 1800;
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
