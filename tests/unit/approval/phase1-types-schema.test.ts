// tests/unit/approval/phase1-types-schema.test.ts
//
// PLAN.md ApprovalWatcher Phase 1 (implementation step 0): the schema +
// type foundation lands BEFORE any watcher code so canary events never
// hit a missing-type rejection at the observer boundary. These tests
// pin the shape down so the upcoming phases can't regress it.

import { describe, it, expect } from "vitest";
import {
  APPROVAL_EVENT_TYPES_LEGACY,
  APPROVAL_EVENT_TYPES_REQUEST_SCOPED,
  APPROVAL_EVENT_TYPES_GLOBAL,
  isApprovalEventType,
  isRequestScopedApprovalEvent,
  isGlobalApprovalEvent,
  DEFAULT_APPROVAL_WATCHER_CONFIG,
  type ApprovalToken,
  type ApprovalWatcherConfig,
  type RequestApprovalPollHint,
  type CheckApprovalStatus,
  type RunState,
} from "../../../src/types.js";
import { loadSafetyConfig } from "../../../src/config.js";
import type { StepResult } from "../../../src/workflows/types.js";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join } from "path";

describe("ApprovalWatcher Phase 1 — schema.ts EVENT_TYPES is synced to types.ts", () => {
  it("EVENT_TYPES.approval includes every type from both scope lists", async () => {
    // Round 2 review angle: catch the gap where schema.ts has its own
    // const map of valid event types but src/types.ts has the canonical
    // list. If the two drift, dashboards or future schema validators
    // will reject canary events.
    const { EVENT_TYPES } = await import("../../../src/observer/schema.js");
    const expected = new Set([
      ...APPROVAL_EVENT_TYPES_REQUEST_SCOPED,
      ...APPROVAL_EVENT_TYPES_GLOBAL,
    ]);
    const actual = new Set(EVENT_TYPES.approval as readonly string[]);
    for (const t of expected) {
      expect(actual.has(t)).toBe(true);
    }
    // And nothing extra in EVENT_TYPES that's not in the typed lists.
    for (const t of actual) {
      expect(expected.has(t as never)).toBe(true);
    }
  });
});

describe("ApprovalWatcher Phase 1 — event-type taxonomy", () => {
  it("legacy approval event types are preserved (back-compat)", () => {
    expect(APPROVAL_EVENT_TYPES_LEGACY).toEqual([
      "request",
      "grant",
      "consume",
      "revoke",
      "expired",
    ]);
  });

  it("request-scoped includes legacy + new dispatch lifecycle events", () => {
    // PLAN.md item 9: request-scoped events carry requestId+runId+op+argsHash
    const expected = [
      "request",
      "grant",
      "consume",
      "revoke",
      "expired",
      "dispatch",
      "deny",
      "dispatch_failed",
      "dispatch_skipped_duplicate",
      "dispatch_skipped_stale",
      "dispatch_skipped_paused",
      "auto_granted_existing_token",
      "request_refused",
      "legacy_payload_backfilled",
      "rollback_requeued",
    ];
    expect(APPROVAL_EVENT_TYPES_REQUEST_SCOPED).toEqual(expected);
  });

  it("global / run-scoped types cover boot, capacity, lease, and ops signals", () => {
    // PLAN.md round-A4 MEDIUM 6 + round-A8 LOW
    const expected = [
      "dispatch_skipped_capacity",
      "lease_skipped",
      "watcher_refused",
      "boot_snapshot",
      "schema_backfilled",
      "alert",
      "config_reload_failed",
    ];
    expect(APPROVAL_EVENT_TYPES_GLOBAL).toEqual(expected);
  });

  it("isApprovalEventType narrows arbitrary strings safely", () => {
    expect(isApprovalEventType("dispatch")).toBe(true);
    expect(isApprovalEventType("lease_skipped")).toBe(true);
    expect(isApprovalEventType("request")).toBe(true); // legacy
    expect(isApprovalEventType("not_a_type")).toBe(false);
    expect(isApprovalEventType("")).toBe(false);
  });

  it("scope discriminators correctly classify each type", () => {
    expect(isRequestScopedApprovalEvent("dispatch")).toBe(true);
    expect(isGlobalApprovalEvent("dispatch")).toBe(false);
    expect(isGlobalApprovalEvent("dispatch_skipped_capacity")).toBe(true);
    expect(isRequestScopedApprovalEvent("dispatch_skipped_capacity")).toBe(false);
    expect(isGlobalApprovalEvent("config_reload_failed")).toBe(true);
    expect(isRequestScopedApprovalEvent("alert")).toBe(false);
  });

  it("the two scope sets do not overlap", () => {
    const intersection = APPROVAL_EVENT_TYPES_REQUEST_SCOPED.filter((t) =>
      (APPROVAL_EVENT_TYPES_GLOBAL as readonly string[]).includes(t),
    );
    expect(intersection).toEqual([]);
  });
});

describe("ApprovalWatcher Phase 1 — type extensions are accepted", () => {
  it("ApprovalToken accepts the new pauseEpoch field", () => {
    const token: ApprovalToken = {
      tokenId: "t1",
      runId: "r1",
      op: "bash",
      argsHash: "h",
      scope: "once",
      expiresAt: new Date().toISOString(),
      signature: "sig",
      pauseEpoch: 0,
      consumed: false,
    };
    expect(token.pauseEpoch).toBe(0);
  });

  it("ApprovalToken still type-checks WITHOUT pauseEpoch (back-compat)", () => {
    // Pre-watcher tokens have no pauseEpoch; the field is optional in the
    // type. The runtime migration (round-A8 HIGH 2) backfills `0`.
    const legacy: ApprovalToken = {
      tokenId: "t1",
      runId: "r1",
      op: "bash",
      argsHash: "h",
      scope: "once",
      expiresAt: new Date().toISOString(),
      signature: "sig",
    };
    expect(legacy.pauseEpoch).toBeUndefined();
  });

  it("RunState accepts schemaVersion + adhocHoldExpiresAt + pauseForUser", () => {
    const state: RunState = {
      runId: "r1",
      workflow: "plan-build-review",
      goal: "test",
      status: "waiting_user",
      currentStep: "idle",
      iteration: 0,
      budget: {
        maxIterations: 1,
        maxCostUsd: 1,
        maxWallSeconds: 60,
        maxTokens: 1000,
        spent: { costUsd: 0, wallSeconds: 0, tokens: 0 },
      },
      steps: [],
      artifacts: {},
      approvals: [],
      planMode: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
      adhocHoldExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      pauseForUser: { reason: "adhoc-approvals-hold" },
    };
    expect(state.schemaVersion).toBe(1);
    expect(state.adhocHoldExpiresAt).toBeTruthy();
    expect(state.pauseForUser?.reason).toBe("adhoc-approvals-hold");
  });

  it("StepResult accepts pauseForUser", () => {
    const r: StepResult = {
      success: true,
      verdict: "PASS",
      pauseForUser: { reason: "adhoc-approvals-hold" },
    };
    expect(r.pauseForUser?.reason).toBe("adhoc-approvals-hold");
  });

  it("RequestApprovalPollHint accepts the three documented values", () => {
    const a: RequestApprovalPollHint = "CheckApproval";
    const b: RequestApprovalPollHint = "next_tool_call";
    const c: RequestApprovalPollHint = "n/a";
    expect([a, b, c]).toEqual(["CheckApproval", "next_tool_call", "n/a"]);
  });

  it("CheckApprovalStatus accepts the five documented values", () => {
    const states: CheckApprovalStatus[] = [
      "pending",
      "granted",
      "denied",
      "not-found",
      "rollback-handoff",
    ];
    expect(states).toHaveLength(5);
  });
});

describe("ApprovalWatcher Phase 1 — DEFAULT_APPROVAL_WATCHER_CONFIG is safe", () => {
  it("defaults to dormant + disabled + no canary opt-in", () => {
    // Safety property: a fresh install must not silently enable any
    // watcher behavior. Every field must default to the "off" position.
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.enabled).toBe(false);
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.mode).toBe("dormant");
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.dispatchPaused).toBe(false);
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.emergencyStop).toBe(false);
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.pauseEpoch).toBe(0);
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.canaryRunIds).toEqual([]);
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.allRuns).toBe(false);
  });

  it("maxRequestAgeSeconds defaults to 3600 (1 hour)", () => {
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.maxRequestAgeSeconds).toBe(3600);
  });

  it("is shape-equal to ApprovalWatcherConfig", () => {
    const c: ApprovalWatcherConfig = { ...DEFAULT_APPROVAL_WATCHER_CONFIG };
    expect(c.enabled).toBe(false);
  });

  it("is frozen — attempting to mutate top-level fields throws in strict mode", () => {
    // Phase 1 review round-2 LOW: an importer that accidentally mutates
    // the singleton would bleed a hostile change into the controller's
    // lifetime. Object.freeze ensures mutation throws (or silently
    // no-ops in sloppy mode) — TypeScript marks the type Readonly so
    // any direct write is also caught at compile time.
    expect(Object.isFrozen(DEFAULT_APPROVAL_WATCHER_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_APPROVAL_WATCHER_CONFIG.canaryRunIds)).toBe(true);
  });

  it("cloneDefaultApprovalWatcherConfig returns a fresh, mutable copy", async () => {
    const { cloneDefaultApprovalWatcherConfig } = await import("../../../src/types.js");
    const a = cloneDefaultApprovalWatcherConfig();
    const b = cloneDefaultApprovalWatcherConfig();
    expect(a).not.toBe(b); // distinct object references
    expect(a.canaryRunIds).not.toBe(b.canaryRunIds); // distinct array references
    a.canaryRunIds.push("test-run");
    expect(b.canaryRunIds).toEqual([]); // mutation does not bleed
    expect(DEFAULT_APPROVAL_WATCHER_CONFIG.canaryRunIds).toEqual([]); // nor to singleton
  });
});

describe("ApprovalWatcher Phase 1 — RunState normalization for new fields", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "approval-runstate-norm-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects schemaVersion as string", async () => {
    // Phase 1 review round-2 MEDIUM 1: a state file with `schemaVersion:"1"`
    // (string instead of number) must NOT slip through normalizeLoadedState
    // as a typed but wrong-shape field.
    const runId = "test-run-1";
    const dir = join(tmpDir, runId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        runId,
        workflow: "plan",
        goal: "test",
        status: "running",
        currentStep: "x",
        iteration: 0,
        budget: { maxIterations: 1, maxCostUsd: 1, maxWallSeconds: 60, maxTokens: 100, spent: { costUsd: 0, wallSeconds: 0, tokens: 0 } },
        steps: [],
        artifacts: {},
        approvals: [],
        planMode: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: "1",
        adhocHoldExpiresAt: "not-a-date",
        pauseForUser: null,
      }),
    );
    const { loadRunState } = await import("../../../src/adw/RunState.js");
    const state = await loadRunState(tmpDir, runId);
    expect(state).not.toBeNull();
    expect(state?.schemaVersion).toBeUndefined();
    expect(state?.adhocHoldExpiresAt).toBeUndefined();
    expect(state?.pauseForUser).toBeUndefined();
  });

  it("accepts well-shaped values for the new fields", async () => {
    const runId = "test-run-2";
    const dir = join(tmpDir, runId);
    await mkdir(dir, { recursive: true });
    const expiry = new Date(Date.now() + 3600000).toISOString();
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        runId,
        workflow: "plan",
        goal: "test",
        status: "waiting_user",
        currentStep: "idle",
        iteration: 0,
        budget: { maxIterations: 1, maxCostUsd: 1, maxWallSeconds: 60, maxTokens: 100, spent: { costUsd: 0, wallSeconds: 0, tokens: 0 } },
        steps: [],
        artifacts: {},
        approvals: [],
        planMode: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
        adhocHoldExpiresAt: expiry,
        pauseForUser: { reason: "adhoc-approvals-hold" },
      }),
    );
    const { loadRunState } = await import("../../../src/adw/RunState.js");
    const state = await loadRunState(tmpDir, runId);
    expect(state?.schemaVersion).toBe(1);
    expect(state?.adhocHoldExpiresAt).toBe(expiry);
    expect(state?.pauseForUser).toEqual({ reason: "adhoc-approvals-hold" });
  });
});

describe("ApprovalWatcher Phase 1 — APPROVAL_TOKEN_SCHEMA_VERSION marker", () => {
  it("exports the version constant (Phase 7 bumped to 2 for pauseEpoch in HMAC)", async () => {
    const { APPROVAL_TOKEN_SCHEMA_VERSION } = await import("../../../src/types.js");
    expect(APPROVAL_TOKEN_SCHEMA_VERSION).toBe(2);
  });
});

describe("ApprovalWatcher Phase 1 — loadSafetyConfig deep-merges approvalWatcher", () => {
  let realHome: string | undefined;
  let tmpHome: string;

  beforeEach(async () => {
    realHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), "approval-phase1-"));
    process.env.HOME = tmpHome;
    await mkdir(join(tmpHome, ".pi", "engineering-team"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("missing safety.json → full default approvalWatcher", async () => {
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher).toEqual(DEFAULT_APPROVAL_WATCHER_CONFIG);
  });

  it("safety.json without approvalWatcher key → full default approvalWatcher", async () => {
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ tokenTtlSeconds: 600 }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.tokenTtlSeconds).toBe(600);
    expect(cfg.approvalWatcher).toEqual(DEFAULT_APPROVAL_WATCHER_CONFIG);
  });

  it("partial approvalWatcher in safety.json → missing fields filled from defaults", async () => {
    // Critical safety property: a user enabling the watcher with
    // `{ enabled: true }` must NOT accidentally clear emergencyStop or
    // dispatchPaused defaults to dangerous values.
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: { enabled: true } }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.enabled).toBe(true);
    expect(cfg.approvalWatcher?.dispatchPaused).toBe(false);
    expect(cfg.approvalWatcher?.emergencyStop).toBe(false);
    expect(cfg.approvalWatcher?.pauseEpoch).toBe(0);
    expect(cfg.approvalWatcher?.canaryRunIds).toEqual([]);
    expect(cfg.approvalWatcher?.allRuns).toBe(false);
    expect(cfg.approvalWatcher?.maxRequestAgeSeconds).toBe(3600);
  });

  // Phase 1 review round-1 MEDIUM 2 + LOW: hostile shapes in safety.json
  // must NOT survive as truthy-but-invalid values that Phase 2+ gates
  // could misread. The sanitizer must per-field fall back to defaults.

  it("approvalWatcher: null → full default approvalWatcher", async () => {
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: null }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher).toEqual(DEFAULT_APPROVAL_WATCHER_CONFIG);
  });

  it("approvalWatcher: 'bogus' string → full default", async () => {
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: "bogus" }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher).toEqual(DEFAULT_APPROVAL_WATCHER_CONFIG);
  });

  it("approvalWatcher: array → full default (not iterated as object)", async () => {
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: ["enabled", true] }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher).toEqual(DEFAULT_APPROVAL_WATCHER_CONFIG);
  });

  it("approvalWatcher: enabled='true' string → kept as default false (no truthy-bypass)", async () => {
    // Silent-truthiness bug guard: a YAML-style "true" must not flip the
    // boolean. Operators have to use real `true` (no quotes).
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: { enabled: "true" } }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.enabled).toBe(false);
  });

  it("approvalWatcher: canaryRunIds='not-an-array' → kept as default []", async () => {
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: { canaryRunIds: "not-an-array" } }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.canaryRunIds).toEqual([]);
  });

  it("approvalWatcher: canaryRunIds=['*'] → wildcard rejected, other entries preserved", async () => {
    // PLAN.md round-A7 MEDIUM 4: wildcard not supported; operators must
    // use allRuns: true explicitly.
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: { canaryRunIds: ["*", "real-run-1", "real-run-2"] } }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.canaryRunIds).toEqual(["real-run-1", "real-run-2"]);
  });

  it("approvalWatcher: mode='bogus' → kept as default 'dormant'", async () => {
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: { mode: "bogus" } }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.mode).toBe("dormant");
  });

  it("approvalWatcher: negative pauseEpoch → kept as default 0", async () => {
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: { pauseEpoch: -5 } }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.pauseEpoch).toBe(0);
  });

  it("approvalWatcher: maxRequestAgeSeconds=0 → kept as default 3600 (0 is invalid)", async () => {
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: { maxRequestAgeSeconds: 0 } }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.maxRequestAgeSeconds).toBe(3600);
  });

  it("typo'd field name preserves all defaults", async () => {
    // `enabld` (typo) doesn't touch `enabled`. Defaults survive.
    await writeFile(
      join(tmpHome, ".pi", "engineering-team", "safety.json"),
      JSON.stringify({ approvalWatcher: { enabld: true, dispatchpaused: true } }),
    );
    const cfg = await loadSafetyConfig();
    expect(cfg.approvalWatcher?.enabled).toBe(false);
    expect(cfg.approvalWatcher?.dispatchPaused).toBe(false);
  });
});

describe("ApprovalWatcher Phase 1 — type guards reject hostile inputs", () => {
  it("isApprovalEventType handles null/undefined/empty without crashing", () => {
    expect(isApprovalEventType(null as unknown as string)).toBe(false);
    expect(isApprovalEventType(undefined as unknown as string)).toBe(false);
    expect(isApprovalEventType("")).toBe(false);
  });

  it("isApprovalEventType is case-sensitive", () => {
    expect(isApprovalEventType("DISPATCH")).toBe(false);
    expect(isApprovalEventType("Dispatch")).toBe(false);
    expect(isApprovalEventType("dispatch")).toBe(true);
  });

  it("no duplicate values within request-scoped set", () => {
    const seen = new Set<string>();
    for (const t of APPROVAL_EVENT_TYPES_REQUEST_SCOPED) {
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
  });

  it("no duplicate values within global set", () => {
    const seen = new Set<string>();
    for (const t of APPROVAL_EVENT_TYPES_GLOBAL) {
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
  });
});

// vitest globals helper imports for beforeEach/afterEach
import { beforeEach, afterEach } from "vitest";
