export const V3_FLAG_NAMES = [
  "gitlab",
  "linear",
  "mcpTrackers",
  "setfit",
  "secondReview",
  "transcriptAudit",
  "bestOfN",
  "dagParallel",
  "mergeQueue",
  "webhooks",
  "collaborateExecution",
  "crossRepoTools",
  "learner",
] as const;

export type V3FlagName = (typeof V3_FLAG_NAMES)[number];

export interface V3Policy {
  gitlab: { enabled: boolean };
  linear: { enabled: boolean };
  mcpTrackers: { enabled: boolean };
  setfit: { enabled: boolean; minLabelsPerClass: number };
  secondReview: { enabled: boolean; rate: number };
  transcriptAudit: { enabled: boolean };
  bestOfN: { enabled: boolean; n: 2 | 3 };
  dagParallel: { enabled: boolean };
  mergeQueue: { enabled: boolean };
  webhooks: { enabled: boolean; bind?: string; secret?: string };
  collaborateExecution: { enabled: boolean };
  crossRepoTools: { enabled: boolean };
  learner: { enabled: boolean };
}

export interface V3HostConfig {
  v3?: Partial<{ [K in keyof V3Policy]: Partial<V3Policy[K]> }> | undefined;
  codify?: { dispatch?: "off" | "shadow" | "partial" | "exact"; shadowAgreeToActivate?: number };
}

export const DEFAULT_V3_POLICY: V3Policy = {
  gitlab: { enabled: false },
  linear: { enabled: false },
  mcpTrackers: { enabled: false },
  setfit: { enabled: false, minLabelsPerClass: 40 },
  secondReview: { enabled: false, rate: 0.1 },
  transcriptAudit: { enabled: false },
  bestOfN: { enabled: false, n: 2 },
  dagParallel: { enabled: false },
  mergeQueue: { enabled: false },
  webhooks: { enabled: false },
  collaborateExecution: { enabled: false },
  crossRepoTools: { enabled: false },
  learner: { enabled: false },
};

export class DispatchDisabled extends Error {
  readonly flag: string;
  constructor(flag: string) {
    super(`v3 dispatch disabled: ${flag}`);
    this.name = "DispatchDisabled";
    this.flag = flag;
  }
}

export function v3Enabled(cfg: V3HostConfig, flag: keyof V3Policy): boolean {
  try {
    const block = cfg.v3?.[flag];
    if (block === undefined || block === null) return false;
    return block.enabled === true;
  } catch {
    return false;
  }
}

export function assertV3(cfg: V3HostConfig, flag: keyof V3Policy): void {
  if (!v3Enabled(cfg, flag)) throw new DispatchDisabled(String(flag));
}
