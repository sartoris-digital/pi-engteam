import { Type, type Static, type TSchema } from "typebox";

// ---------------------------------------------------------------------------
// Constants and unions
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1 as const;

export const KINDS = ["feature", "enhancement", "bug", "chore"] as const;
export type Kind = (typeof KINDS)[number];

/** Merge order of the five configuration layers (spec §2.1). */
export type LayerName = "builtin" | "global" | "committed" | "overrides" | "local";
export const LAYER_ORDER: readonly LayerName[] = ["builtin", "global", "committed", "overrides", "local"];

export type PolicyLevel = "never" | "elevated" | "always";
export type SandboxMode = "off" | "best-effort" | "required";
export type TrackerKind = "github" | "azure-devops" | "jira";
export type DraftPolicy = "elevated" | "always" | "never";

const strict = { additionalProperties: false } as const;
const StringList = Type.Array(Type.String());
const Argv = Type.Array(Type.String(), { minItems: 1 });
const PositiveInt = Type.Integer({ minimum: 1 });
const NonNegativeInt = Type.Integer({ minimum: 0 });
const NonNegativeNumber = Type.Number({ minimum: 0 });

/** Overlay leaf: absent = inherit, `null` = delete the key (merge.ts). Blocks are never nullable. */
const leaf = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));

export const PolicyLevelSchema = Type.Union([Type.Literal("never"), Type.Literal("elevated"), Type.Literal("always")]);
export const SandboxModeSchema = Type.Union([Type.Literal("off"), Type.Literal("best-effort"), Type.Literal("required")]);
export const TrackerKindSchema = Type.Union([Type.Literal("github"), Type.Literal("azure-devops"), Type.Literal("jira")]);
export const DraftPolicySchema = Type.Union([Type.Literal("elevated"), Type.Literal("always"), Type.Literal("never")]);

// ---------------------------------------------------------------------------
// Operator block (global file only) — overlay schema
// ---------------------------------------------------------------------------

export const TrackerEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: TrackerKindSchema,
    org: Type.Optional(Type.String()),
    project: Type.Optional(Type.String()),
    site: Type.Optional(Type.String()),
    projectKey: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    allowedAuthors: Type.Optional(StringList),
    allowedLabelers: Type.Optional(StringList),
    ignoreAuthors: Type.Optional(StringList),
    transitionOnClaim: Type.Optional(Type.Boolean()),
    transitionOnMerge: Type.Optional(Type.Boolean()),
    transitions: Type.Optional(
      Type.Object({ claim: Type.Optional(Type.String()), merge: Type.Optional(Type.String()) }, strict),
    ),
    assignOnClaim: Type.Optional(Type.Boolean()),
    assigneeEnqueue: Type.Optional(
      Type.Object({ enabled: Type.Boolean(), account: Type.Optional(Type.String()) }, strict),
    ),
  },
  strict,
);
export type TrackerEntry = Static<typeof TrackerEntrySchema>;

export const FusionSlotSchema = Type.Object(
  { name: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }), thinking: Type.Optional(Type.String()) },
  strict,
);
export type FusionSlot = Static<typeof FusionSlotSchema>;

export const CodifyOverlaySchema = Type.Object(
  {
    enabled: leaf(Type.Boolean()),
    repos: leaf(StringList),
    eligibility: leaf(Type.Literal("landed")),
    minRecurrence: leaf(PositiveInt),
    schedule: leaf(Type.String()),
    window: leaf(Type.String()),
    reserveUsd: leaf(NonNegativeNumber),
    maxPerDay: leaf(NonNegativeInt),
    maxCandidatesPerRun: leaf(NonNegativeInt),
    requireIdleLanes: leaf(NonNegativeInt),
    forwardRoi: leaf(NonNegativeNumber),
    dispatch: leaf(
      Type.Union([Type.Literal("off"), Type.Literal("shadow"), Type.Literal("partial"), Type.Literal("exact")]),
    ),
    pythonDeps: leaf(StringList),
    maxActivePerRepo: leaf(NonNegativeInt),
    maxActiveGlobal: leaf(NonNegativeInt),
    staleDays: leaf(NonNegativeInt),
    shadowAgreeToActivate: leaf(PositiveInt),
    demoteAfterFailures: leaf(PositiveInt),
    cooldownDays: leaf(NonNegativeInt),
    taskTools: Type.Optional(
      Type.Object({ unattended: leaf(Type.Union([Type.Literal("never"), Type.Literal("always")])) }, strict),
    ),
  },
  strict,
);

export const OperatorOverlaySchema = Type.Object(
  {
    trackers: leaf(Type.Array(TrackerEntrySchema)),
    github: Type.Optional(Type.Object({ appToken: leaf(Type.String()) }, strict)),
    coAuthoredBy: leaf(Type.Boolean()),
    maxLanes: leaf(PositiveInt),
    maxLanesPerRepo: leaf(PositiveInt),
    dailyBudgetUsd: leaf(NonNegativeNumber),
    maxTicketsPerDay: leaf(NonNegativeInt),
    pollIntervalSeconds: leaf(PositiveInt),
    allowBurstLane: leaf(Type.Boolean()),
    maxAttempts: leaf(PositiveInt),
    abandonDays: leaf(NonNegativeInt),
    providerKeyEnv: leaf(Type.String()),
    intake: Type.Optional(Type.Object({ model: leaf(Type.String()) }, strict)),
    steeringApprovers: leaf(Type.Union([Type.Literal("tui"), Type.Literal("tui+tracker")])),
    steerTimeoutHours: leaf(NonNegativeNumber),
    worktreeRoot: leaf(Type.String()),
    workers: leaf(Type.Union([Type.Literal("auto"), Type.Literal("visible"), Type.Literal("headless")])),
    visibleStages: leaf(StringList),
    interrupt: Type.Optional(
      Type.Object(
        {
          onIdleWithoutVerdict: leaf(
            Type.Union([Type.Literal("ask"), Type.Literal("resume"), Type.Literal("block")]),
          ),
        },
        strict,
      ),
    ),
    fusion: Type.Optional(
      Type.Object(
        {
          stack: leaf(Type.Array(FusionSlotSchema)),
          synthesizer: leaf(Type.String()),
          providerConcurrency: leaf(Type.Record(Type.String(), PositiveInt)),
          budgetMultiplier: leaf(Type.Number({ minimum: 1 })),
          slotTimeoutSeconds: leaf(PositiveInt),
          off: leaf(Type.Boolean()),
        },
        strict,
      ),
    ),
    enabledModels: leaf(StringList),
    notify: Type.Optional(Type.Object({ command: leaf(Argv) }, strict)),
    gcDays: leaf(NonNegativeInt),
    landReminderDays: leaf(NonNegativeInt),
    codify: Type.Optional(CodifyOverlaySchema),
  },
  strict,
);
export type OperatorOverlay = Static<typeof OperatorOverlaySchema>;

// ---------------------------------------------------------------------------
// Repo-scope keys — overlay schema (global `defaults`, layers 3, 4, 5)
// ---------------------------------------------------------------------------

export const BranchingOverlaySchema = Type.Object(
  {
    base: leaf(Type.String({ minLength: 1 })),
    target: leaf(Type.String({ minLength: 1 })),
    nameTemplate: leaf(Type.String({ minLength: 1 })),
    titleTemplate: leaf(Type.String({ minLength: 1 })),
    draftPolicy: leaf(DraftPolicySchema),
    linkStyle: leaf(Type.String({ minLength: 1 })),
  },
  strict,
);

export const CheckSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    argv: Argv,
    reporter: Type.Union([Type.Literal("junit"), Type.Literal("none")]),
    timeoutSeconds: Type.Optional(PositiveInt),
    junitPath: Type.Optional(Type.String()),
  },
  strict,
);

export const WriteRootsOverlaySchema = Type.Object(
  { feature: leaf(StringList), enhancement: leaf(StringList), bug: leaf(StringList), chore: leaf(StringList) },
  strict,
);

export const RepoDefaultsSchema = Type.Object(
  {
    branching: Type.Optional(BranchingOverlaySchema),
    setupCommand: leaf(Argv),
    setupTimeoutSeconds: leaf(PositiveInt),
    installTimeoutSeconds: leaf(PositiveInt),
    allowInstallScripts: leaf(Type.Boolean()),
    dependencyUpdateCommand: leaf(Argv),
    codegenCommands: leaf(Type.Array(Argv)),
    checks: leaf(Type.Array(CheckSchema)),
    checksTimeoutSeconds: leaf(PositiveInt),
    checksConcurrency: leaf(PositiveInt),
    stageTimeoutSeconds: leaf(PositiveInt),
    testDir: leaf(Type.String({ minLength: 1 })),
    testPattern: leaf(Type.String({ minLength: 1 })),
    testInfra: leaf(StringList),
    writeRoots: Type.Optional(WriteRootsOverlaySchema),
    riskPaths: leaf(StringList),
    securityPaths: leaf(StringList),
    exclusivePaths: leaf(StringList),
    generatedPaths: leaf(StringList),
    generatedDocPatterns: leaf(StringList),
    maxDiffLines: leaf(PositiveInt),
    maxChangedFiles: leaf(PositiveInt),
    laneEnv: Type.Optional(
      Type.Object(
        { template: leaf(Type.String()), basePort: leaf(Type.Integer({ minimum: 1, maximum: 65535 })) },
        strict,
      ),
    ),
    steering: leaf(PolicyLevelSchema),
    planApproval: leaf(PolicyLevelSchema),
    sandbox: leaf(SandboxModeSchema),
  },
  strict,
);
export type RepoDefaults = Static<typeof RepoDefaultsSchema>;

export const RepoEntrySchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    remote: Type.Optional(Type.String({ minLength: 1 })),
    tracker: Type.Optional(Type.String()),
    project: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    overrides: Type.Optional(RepoDefaultsSchema),
    lanes: Type.Optional(Type.Unknown()), // v1: lane overrides (spec §2.1); accepted, not interpreted in v0
    rules: Type.Optional(Type.Unknown()), // v1: rule overrides (spec §2.5); accepted, not interpreted in v0
  },
  strict,
);
export type RepoEntry = Static<typeof RepoEntrySchema>;

/** `~/.pi/sdlc-factory/factory.json` (layer 2 + the repos[] registry that carries layer 4). */
export const FactoryConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(SCHEMA_VERSION),
    operator: Type.Optional(OperatorOverlaySchema),
    defaults: Type.Optional(RepoDefaultsSchema),
    repos: Type.Optional(Type.Array(RepoEntrySchema)),
  },
  strict,
);
export type FactoryConfig = Static<typeof FactoryConfigSchema>;

/** `<repo>/.pi/factory.json` (layer 3) and `<repo>/.pi/factory.local.json` (layer 5). */
export const RepoFileSchema = Type.Object(
  { schemaVersion: Type.Literal(SCHEMA_VERSION), ...RepoDefaultsSchema.properties },
  strict,
);
export type RepoFile = Static<typeof RepoFileSchema>;

// ---------------------------------------------------------------------------
// Resolved shapes (after merging with DEFAULTS; what the rest of the factory consumes)
// ---------------------------------------------------------------------------

export interface Branching {
  base: string;
  target: string;
  nameTemplate: string;
  titleTemplate: string;
  draftPolicy: DraftPolicy;
  linkStyle: string;
}

export interface CheckDef {
  name: string;
  argv: string[];
  reporter: "junit" | "none";
  timeoutSeconds: number;
  junitPath?: string;
}

export interface LaneEnv {
  template?: string;
  basePort?: number;
}

export interface CodifyConfig {
  enabled: boolean;
  repos: string[];
  eligibility: "landed";
  minRecurrence: number;
  schedule: string;
  window: string;
  reserveUsd: number;
  maxPerDay: number;
  maxCandidatesPerRun: number;
  requireIdleLanes: number;
  forwardRoi: number;
  dispatch: "off" | "shadow" | "partial" | "exact";
  pythonDeps: string[];
  maxActivePerRepo: number;
  maxActiveGlobal: number;
  staleDays: number;
  shadowAgreeToActivate: number;
  demoteAfterFailures: number;
  cooldownDays: number;
  taskTools: { unattended: "never" | "always" };
}

export interface OperatorConfig {
  trackers: TrackerEntry[];
  github: { appToken?: string };
  coAuthoredBy: boolean;
  maxLanes: number;
  maxLanesPerRepo: number;
  dailyBudgetUsd: number;
  maxTicketsPerDay: number;
  pollIntervalSeconds: number;
  allowBurstLane: boolean;
  maxAttempts: number;
  abandonDays: number;
  providerKeyEnv?: string;
  intake: { model?: string };
  steeringApprovers: "tui" | "tui+tracker";
  steerTimeoutHours?: number;
  worktreeRoot: string;
  workers: "auto" | "visible" | "headless";
  visibleStages: string[];
  interrupt: { onIdleWithoutVerdict: "ask" | "resume" | "block" };
  fusion: {
    stack: FusionSlot[];
    synthesizer?: string;
    providerConcurrency: Record<string, number>;
    budgetMultiplier: number;
    slotTimeoutSeconds: number;
    off: boolean;
  };
  enabledModels?: string[];
  notify: { command?: string[] };
  gcDays: number;
  landReminderDays: number;
  codify: CodifyConfig;
}

/** Contract shape (v0-contract.md) plus optional v0 extras that loadEffectiveConfig always fills in. */
export interface EffectiveRepoConfig {
  repoRoot: string;
  remote: string;
  branching: Branching;
  checks: CheckDef[];
  testDir: string;
  testPattern: string;
  testInfra: string[];
  setupCommand?: string[];
  setupTimeoutSeconds: number;
  allowInstallScripts: boolean;
  writeRoots: Record<Kind, string[]>;
  riskPaths: string[];
  securityPaths: string[];
  exclusivePaths: string[];
  generatedPaths: string[];
  maxDiffLines: number;
  maxChangedFiles: number;
  steering: PolicyLevel;
  planApproval: PolicyLevel;
  stageTimeoutSeconds: number;
  checksTimeoutSeconds: number;
  checksConcurrency: number;
  generatedDocPatterns: string[];
  sandbox: SandboxMode;
  installTimeoutSeconds?: number;
  codegenCommands?: string[][];
  dependencyUpdateCommand?: string[];
  laneEnv?: LaneEnv;
}

export interface EffectiveConfig {
  operator: OperatorConfig;
  repo: EffectiveRepoConfig;
  /** `"operator.<dotted key>"` / `"repo.<dotted key>"` → the layer that set it (an array counts as one key). */
  provenance: Record<string, LayerName>;
  /** sha256 hex of canonicalJson({ operator, repo }); pinned into RunState.configSha. */
  configSha: string;
}
