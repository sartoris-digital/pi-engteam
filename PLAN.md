# PLAN: GHCP-parity hardening + real-time agent-activity feedback

## Context

Pi-engineering 2.0.11→2.0.15 shipped piecemeal CoPilot fixes (verdict file
fallback, forcing-retry, stdout-scan, artifact synthesis, name normalization,
collision suffix, per-run-dir upsert, absolute-path artifact resolution, judge
prompt path injection). This plan finishes the parity work and adds a
real-time agent-activity feed so the operator can see the same
thinking/tool-call interleave that the bare `pi` CLI shows.

Scope: BOTH GHCP parity AND real-time UI.
Constraint: no changes to upstream `pi-coding-agent` / `pi-tui` / `pi-ai`.
Worries: tool-inventory drift across providers/versions, stdout buffering,
ordering, and synthesis/upsert masking real failures.

## Phase 0 — Measurement (run BEFORE designing anything else)

0a. **Capability probe harness — isolated workspace** (revised, round 2
    MED #7): `scripts/probe-pi-provider.sh <provider>` spawns
    `pi -p --no-session` under the orchestrator's exact subprocess
    flags but rooted in a freshly-created `mktemp -d`/probe-runDir,
    NOT the real project. The probe injects pre-known canary files
    (`probe-canary-{1,2,3}.txt` with random sentinel content) and
    a stub `runs/` tree. Real-mutation channels are stubbed:
    `RequestApproval`/`GrantApproval`/`UseSecret` route to no-op
    in-process mocks; `SendMessage` is disabled entirely; outbound
    network calls beyond the model API are blocked via the
    orchestrator's network-restrictor. The harness exercises a fixed
    prompt asking the model to list every tool, attempt VerdictEmit,
    Write to `$PI_ENGINEERING_VERDICT_FILE`, Edit, Read each canary,
    and attempt SendMessage. Captures stdout + stderr + audit JSONL
    and writes `<provider>-<piVersion>-capability.json` containing
    observed tool set, sentinel-call outcomes, and which content
    types (`thinking`, `tool_call_invoke`, `tool_call_result`,
    `assistant_text`) appeared on which stream at which lifecycle
    point. Bundle (capability JSON + raw evidence, redacted via item
    18) is retained at `~/.pi/engineering-team/capabilities/<bundle>`
    with **bounded retention** (round 9 LOW + round 15 MED #2):
    per-provider cap of 100 bundles + 256 MB; GC runs on every
    new probe and keeps the most-recent bundle per FULL
    `runtimeFingerprint` tuple (provider, modelId,
    accountFingerprint, piVersion, piBuildHash, protocolVersion,
    sortedRuntimeFlags — same tuple E9 uses). Additionally,
    bundles for ANY actively-exposed rollout cohort are PINNED
    against GC regardless of age. Canary advancement fails if
    any exposed cohort lacks a warm concrete (non-baseline,
    non-wildcard) bundle — paged via
    `pi_eng_canary_cold_cohort_total{provider}`. N=10
    fleet-wide most-recent; bundles older than
    `bundleTtlDays` (default 90) are pruned. Metrics
    `pi_eng_capability_bundle_disk_bytes` +
    `pi_eng_capability_bundle_gc_total{reason}` published per E4.
    Cache-reuse rule: a fresh probe is required only on
    `runtimeFingerprint` mismatch (E9); otherwise the cached bundle
    is reused while in retention. Probe-runDir is wiped on success;
    preserved with `.failed` suffix on harness error (counts
    against the same GC quota). THIS FILE is what gates Phase A
    and Phase B.

0b. **Stream-source survey**: for each provider, the probe records
    whether real-time chunks arrive on stdout, stderr, audit JSONL
    pre-close, audit JSONL post-close-only, or PTY-required. Phase B's
    classifier wires to the proven source per provider, not a
    presumed one.

## Phase A — GHCP compatibility (provider-agnostic core)

1. **Capability matrix gating — schema + provenance + observe/warn/enforce
   modes** (revised, round 2 LOW #9 + round 3 HIGH + round 3 MED #1):
   `src/team/capability-matrix.ts` ingests Phase 0a files and exposes
   `getCapabilities({provider, piVersion, ...}) → {tools[], streams,
   notes, provenance}`. Capability JSON validated against
   `capability-schema.json` (TypeBox) and MUST carry full provenance:
   `{provider, modelId, accountFingerprint, piVersion, piBuildHash,
   piEngVersion, protocolVersion, runtimeFlags[], probeTs,
   probeBundleHash, harnessVersion}`. The gate runs in one of three
   modes set by `PI_ENGINEERING_CAPABILITY_MODE` (default
   `warn` for the 2.1.0 release window, then `enforce` after the
   canary period):
   - `observe`: log capability lookup + matched/missing fallbacks,
     never block. NOTE: this is NOT a 2.0.x parity mode — other
     Phase A behaviors remain active. For true 2.0.x parity use
     `PI_ENGINEERING_LEGACY_MODE=2.0.x` (item 24).
   - `warn`: log + emit a stderr banner on mismatch / staleness /
     missing-tool, run proceeds.
   - `enforce`: hard-fail with `provider-missing-capability` upfront.
   Hand-edited / hash-broken / stale files are refused in `enforce`,
   warned in `warn`, ignored in `observe`. **Bundled baseline
   semantics** (round 10 MED #1): the shipped per-provider
   baseline capability JSONs carry `accountFingerprint: "*"`,
   `modelId: "*"`, `runtimeFlags: ["*"]` (wildcard provenance)
   and a `baselineOnly: true` flag. Baselines are USED ONLY in
   `observe` or `warn` modes, AND as a seed for the first-spawn
   probe under any mode. In `enforce` mode the orchestrator
   REFUSES to run a workflow until at least one per-account
   probe has produced a concrete (non-wildcard) capability
   bundle. The first probe is performed inline at server start
   or first CLI invocation; subsequent spawns reuse the bundle
   per the cache-reuse rule. Account/model drift tests in CI
   simulate switching accounts and assert the gate behaves
   correctly per mode.
   Emergency downgrade goes through the canonical rollback runbook
   (E6) — NOT a direct LKG install. For true 2.0.x runtime parity
   use `PI_ENGINEERING_LEGACY_MODE=2.0.x` (item 24) — NOT
   `CAPABILITY_MODE=observe`, which only narrows the capability
   gate. CI fails if the runbook docs or any incident-guide
   reference the stale "observe restores 2.0.x" wording.

2. **Per-tool fallback registry** (drives the system prompt and the
   capability gate): `src/team/tool-fallbacks.ts` maps every custom
   tool to `{ filePath?, schema, requires: capabilityKey[], available:
   (caps) => bool, render: (ctx) => string }`. `buildSystemPrompt`
   queries this registry to produce the compat table, eliminating
   silent-break risk if Pi renames `write` to `writeFile`. Tools
   without any usable path remain documented as fail-fast (already
   the case for RequestApproval / GrantApproval / UseSecret).

3. **Model routing — preserve explicit prefixes** (revised): NEVER
   strip `provider/model` prefixes when configured. Default-routed
   bare aliases (e.g. `claude-opus-4.6`) resolve at boot through
   `pi --list-models` (or whatever Pi exposes per the probe), with a
   declared provider-preference list per alias and a hard fail if no
   candidate works. model-routing.json explicit entries pass through
   unchanged. Resolution result is logged once per boot.

4. **Verdict-file slot — host-owned, atomic, one-shot, symlink-refusing**
   (revised, round 2 HIGH #3): the orchestrator pre-creates
   `<runDir>/_verdicts/<agent>-<step>-<token>.json` BEFORE spawning the
   subprocess, owned by the host process, with `O_NOFOLLOW` checks so a
   symlink at that path is refused. Layer-A exception is keyed on the
   tuple `(canonicalPath, inode, agent, step, token)` resolved at host
   pre-creation — not on the env-var string alone — so a swap of the
   file under the agent's feet cannot redirect the write. The model
   writes via `write` (preferred) OR `edit` (shim: orchestrator
   pre-fills an empty `{}` so edit has something to operate on). After
   the agent emits a verdict OR the step deadline elapses, the host
   reads the slot, validates schema + agent + step + token, then
   atomically seals (chmod 0o400 + closes the inode reference). Later
   writes to the same path are refused.

5. **Per-step timeout configuration + absolute step deadline**: every
   Step gets `timeoutSeconds` (default 240, judge 360). TeamRuntime
   uses an absolute `stepDeadline = stepStart + timeoutSeconds` —
   retries do NOT reset it. Timeout raises typed
   `AgentVerdictTimeoutError` carrying `{elapsed, remaining, attempts}`
   so callers can emit clear "agent timed out at step X after Ys"
   UI messages and the budget cap still trips.

6. **Forced verdict re-prompt budget with bounded redacted excerpts**:
   deliver-retry budget lifts to N attempts (default 2). Each retry's
   forcing message includes ONLY a 4 KB redacted tail of the last
   stdout (passed through the same redaction pipeline as item 20),
   not the full buffer. Retries respect the absolute step deadline
   from item 5.

7. **Tier-fired-fallback telemetry**: every fallback firing
   (stdout-scan, filename-normalization, artifact-synthesis,
   forced-retry, verdict-file-via-write, verdict-file-via-edit,
   capability-mismatch) emits one line to
   `<runsDir>/_telemetry/fallbacks.jsonl` with
   `{ts, runId, agent, step, tier, provider, piVersion, durationMs}`.
   Operators query this to spot models that consistently rely on
   deep fallbacks.

8. **Per-step host acceptance predicates** (revised, round 2 MED #8):
   each Step declares an `acceptPass(verdict, runDir, runCtx) →
   {ok, reasons[]}` predicate executed BY THE HOST (not by the
   model). Defaults: required artifacts exist on disk + nonzero
   bytes + valid markdown + expected sections (from the step's
   `requiredSections[]`). Workflow-specific predicates layered on
   top: e.g. `fix-loop.test` runs `pnpm test` and asserts a 0
   exit code; `fix-loop.implement` asserts at least one file in
   `src/`/`tests/` changed since step start; `triage.classify`
   asserts severity ∈ {P0,P1,P2,P3} in the artifact; `debug.analyze`
   asserts at least one file path + line range in the artifact;
   `verify` asserts the verifier-script ran on its declared inputs.
   **Synthesized verdicts** (item from 2.0.11+ stack) are tagged
   `provenance: "synthesized"` and treated as NON-AUTHORITATIVE for
   any safety-gating step (judge-gate, verify, security-auditor) —
   those steps require a real model-emitted artifact and the
   workflow-specific predicate hit before PASS sticks. After retry
   budget exhausts, escalate to FAIL — never loop on thin NEEDS_MORE.

9. **State-file protection inside broadened upsert** (revised, round 2
   HIGH #1 + round 15 HIGH #3): per-run-dir is in every agent's
   upsert. Layer-A `isProtectedPath` MUST hard-block agent writes
   to ALL orchestrator-owned paths under runDir: `state.json`,
   `events.jsonl`, `conversation.jsonl`, `tasks.json`,
   `agent-activity.jsonl`, `feature-decisions.json`, `_verdicts/`,
   `_telemetry/` (orchestrator append-only — agents read only).
   `feature-decisions.json` is written ONCE at run start by the host
   process and treated as write-once: subsequent writes (even from
   the host) require a hash + inode match against the original
   `(runId, fileHash)` recorded in `<configDir>/feature-decisions-
   audit.jsonl`. The `RunActivityQueue` (item 13) and telemetry
   writer (item 7) are the SINGLE writers for their respective
   files. Tamper tests assert an agent attempting Write/Edit on any
   of these paths is hard-blocked even though the parent dir is in
   upsert, even via symlink, even via path-traversal segments, AND
   that swapping `feature-decisions.json` with a forged copy is
   detected on next read.

10. **Cost + token book-keeping fallback**: when `verdict.usage` is
    missing (GHCP subscription endpoints), track wall-clock per step
    + subprocess-spawn count. Budget cap trips on whichever metric
    available. Run state surfaces `usage-unavailable` so the UI shows
    "budget based on wall-clock only".

## Phase B — Real-time agent-activity feed (gated on Phase 0 measurements)

11. **Per-chunk forwarding off the proven source** (revised from
    "stdout assumption"): the source — stdout, stderr, audit JSONL
    pre-close, or PTY — is determined per provider from Phase 0b.
    `TeamRuntime.deliverOnce` adds a callback that fires on every
    raw chunk from the chosen source BEFORE line-buffering, in
    addition to the existing line-based callback. If the probe
    showed audit-only/post-close, the activity feed switches to a
    delayed/no-realtime UI for that provider with a clear "Pi-cli
    does not expose realtime stream for <provider>" indicator.

12. **Pi-cli output classifier**: `src/team/StreamClassifier.ts`
    parses each chunk into typed events (`thinking`,
    `tool_call_invoke`, `tool_call_result`, `assistant_text`,
    `error`) using the protocol observed in Phase 0a. Unrecognized
    chunks classify as `assistant_text`. Classifier is stateless
    per-chunk where possible, with a small accumulator only for
    multi-chunk fenced blocks.

13. **Activity event + decoupled producer/consumer with isolated
    storage** (revised, round 2 MED #4 + round 3 MED #2 + round 4
    MED #1 + MED #4): `AgentActivityEvent = {runId, agentName, step,
    seq, sourceTs, kind, body, sourceClass}`. The producer side
    (stdout reader, audit drainer, classifier) NEVER blocks on
    persistence/UI. Subprocess stdout is drained at full speed into
    a fixed-size in-memory ring; only the disk writer + SSE
    broadcaster + queue depth consumer can block on each other,
    not on the subprocess. When the ring is full:
    - non-essential kinds (`thinking`, `pipe-buffered`) drop with
      `pi_eng_activity_drops_total{kind}` increment;
    - essential kinds (`tool_call_invoke`, `tool_call_result`,
      `error`, `verdict`, `stuck-warning`) coalesce into a single
      `(N essential events dropped)` summary instead of blocking;
    - if essential coalescing fires more than 3× in 60s, Phase B
      auto-disables for the remainder of this run (kill switch
      latches; `pi_eng_phase_b_auto_disabled_total` increments;
      `stuck-warning` is still tracked locally).
    Storage is ISOLATED from core run state: activity files live
    under `<runsDir>/_activity/<runId>/` (NOT `<runDir>/`), so
    quota exhaustion only refuses new ACTIVITY logging, never
    refuses new RUNS. `agent-activity.jsonl` is written with
    `O_APPEND` + flock at `<runsDir>/_activity/<runId>/.lock`, seq
    persisted at `<runsDir>/_activity/<runId>/_seq.json`. Per-run
    quota default 64 MB with gz rotation; global `_activity` quota
    default 4 GB triggers the active-run-aware pruner (E10) — NOT
    naive oldest-first delete, NOT new-run refusal. Replay skips
    trailing partial lines and truncates on next open. Metric names
    listed in the catalog (E4).

14. **Direct in-process callback for embedded TUI** + **optional SSE
    for browser dashboard** (revised, round 2 HIGH #2 + round 5
    MED #1): the existing pi-engineering server (where present)
    gets an SSE endpoint that relays `RunActivityQueue` events.
    The CLI TUI uses an in-process callback that does NOT require
    the server. ALL consumer paths (SSE, tail, replay, protection
    rules) resolve the activity layout through a single helper
    `src/team/activityPaths.ts: getActivityPaths(runId) →
    {dir, jsonl, lock, seq}` so the on-disk layout (currently
    `<runsDir>/_activity/<runId>/agent-activity.jsonl`) can move
    without spraying string concatenations everywhere. SSE + tail
    enforce: (a) unguessable per-runtime bearer token from
    `<configDir>/server-token` (mode 0600, regenerated on server
    start) required in `Authorization` header; (b) the existing
    centralized `isSafeRunId()` predicate (NOT a UUID-only regex)
    so legacy/manual/test run IDs still resolve;
    (c) path resolution via `realpath` rooted under `runsDir` with a
    refusal if the resolved path escapes; (d) localhost-only bind
    by default. Server lifecycle: documented start/stop,
    healthcheck on `/healthz`, version-pinned protocol header so an
    old browser tab degrades gracefully. Upgrade/downgrade tests
    cover BOTH the legacy `<runDir>/agent-activity.jsonl` location
    and the new `_activity` layout so in-flight runs from earlier
    versions are still tailable.

15. **CLI live tail mode** (revised, round 2 HIGH #2 + round 6
    MED #1 + LOW): `pi engineering tail <runId>` (or `--follow` on
    `run-status`) reads `RunActivityQueue` either in-process
    (same-process capability) or by tailing the JSONL resolved
    through `getActivityPaths(runId)` (item 14). The CLI validates
    the run-id with the existing centralized safe-runId predicate
    (`isSafeRunId(...)`) — NOT a UUID-only regex — so legacy /
    manual / test runs with non-UUID IDs remain tailable. The
    helper resolves `realpath(jsonl)` under `realpath(runsDir)`
    BEFORE opening, refusing any path that escapes or follows a
    symlink out. Legacy-layout fallback: if the new `_activity`
    path is absent for the run, fall through to the legacy
    `<runDir>/agent-activity.jsonl`. Color-coded prefix
    `[<agent>·<step>·<kind>]`, dim for thinking, bold for
    tool_call_invoke, default for results. Works headless / SSH.

16. **Lifecycle-aware stuck detector** (revised): distinguish four
    states explicitly — `model-silent` (process alive, no stdout in
    Ns), `tool-running` (last event was tool_call_invoke without a
    matching result), `pipe-buffered` (raw byte count rising but no
    classified event), `dead-child` (process exited unexpectedly).
    The UI renders each state distinctly; the
    `stuck-warning` event only fires for `model-silent > 90s` AND
    `tool-running > 300s`, not bare silence.

17. **Capability-aware stream replay**: the dashboard run-detail
    page reads `agent-activity.jsonl` for a finished run and
    renders the same way as the live stream, with a one-line
    header noting the source class (stdout / audit / PTY) so the
    operator knows whether realtime was possible for that provider.

## Phase C — Edge cases + safety

18. **Central streaming redaction pipeline** (revised, round 2 MED #5
    + MED #6): `src/team/Redactor.ts` is the SINGLE choke point.
    Every event body, retry-prompt excerpt, disk persistence, SSE
    emit, UI render passes through it. Order: **redact FIRST, then
    truncate** — the redactor is streaming with a 256-byte rolling
    boundary overlap so secrets straddling chunk/truncation
    boundaries still match. Patterns: env-name suffixes (`*_TOKEN`,
    `*_KEY`, `*_SECRET`, `*_PASSWORD`), shape matches (`sk-...`,
    `ghp_...`, JWT-shaped, AWS-key-shaped, GHCP-subscription-token
    shape), and a configurable extra-pattern hook. Output preserves
    `[REDACTED:<reason>:<originalLen>]`. The redactor also strips
    ANSI/OSC terminal control sequences for CLI/TUI output,
    JSON-encodes bodies for SSE (no raw HTML), and HTML-escapes
    bodies for dashboard render. Trusted event metadata (agent,
    step, kind, ts) renders outside the untrusted body block so a
    spoofed `[bug-triage·classify·thinking]` prefix in body text
    cannot impersonate real metadata.

19. **Per-event body size cap + per-step volume cap** (revised, round 2
    MED #5): every event body is first redacted via the streaming
    redactor (item 18), THEN truncated at `maxEventBodyBytes`
    (default 32 KB). Truncated remainder is recorded as
    `[TRUNCATED:<droppedBytes>]`. Per-step cumulative cap of 8 MB /
    50 000 events; after that, subsequent events collapse to one
    `(N more events suppressed)` summary. Classification (item 12)
    operates on the redacted+truncated body so unrecognized garbage
    can't smuggle untruncated content into the type system.

20. **PI version detection** at boot: parse `pi --version`. If
    <0.73, log a warning citing the GHCP-subprocess gaps closed
    by 2.0.11–2.0.15 and the new capability probe. If <0.65 (peer
    floor), fail fast with a clear message. Version + provider
    detection seeds the capability matrix lookup in item 1.

21. **Backwards-compat for Anthropic-direct**: every Phase A and B
    item must no-op when the capability matrix shows full custom-tool
    support: VerdictEmit single-shot, no synthesis, no forced
    retries beyond N=0, no acceptance-predicate downgrade. Activity
    stream still populates from the same source per Phase 0b.
    Regression tests assert this.

## Phase E — Observability, on-call, rollback

E1. **Alert thresholds + runbook (catalog-bound, label-explicit)**
    (revised, round 3 MED #3 + round 5 LOW + round 11 LOW):
    runbook entries import exact metric symbols from
    `metric-catalog.ts` (E4) AND must specify the aggregation
    expression — `sum`, `sum by (label)`, or `avg by (label)` —
    so generated alerts are unambiguous about per-surface,
    per-provider, or summed-across-dimensions firing. The build
    fails if any runbook reference omits an aggregation rule or
    does not resolve to a catalog symbol. Threshold tests assert
    that, for any multi-label metric, both an aggregate and a
    per-label-value test path exist (e.g.
    `pi_eng_activity_disk_usage_bytes{surface=canonical}` and
    `{surface=legacy-mirror}` get separate alert paths). The
    runbook Markdown is GENERATED from the catalog + this
    threshold table — never hand-edited. Default thresholds:
    - `pi_eng_fallback_fired_total{tier,agent,step,provider}` —
      alert when `rate(...)>0.5/min` for any tier deeper than
      tier-3 (synthesis) sustained 10m; runbook: re-probe provider,
      check Pi version.
    - `pi_eng_verdict_timeout_total{agent,step}` — alert when >3
      in 30m for the same `(agent,step)`; runbook: raise step
      timeout or switch model tier.
    - `pi_eng_activity_drops_total{kind}` — alert when
      `rate({kind="thinking"})>1k/min`; alert ANY rate for
      `kind∈{tool_call_invoke, tool_call_result, error, verdict}`.
    - `pi_eng_activity_disk_usage_bytes` /
      `pi_eng_activity_disk_quota_bytes` — page when ratio >85%;
      runbook: active-run-aware pruner (E10) should already be
      degrading old terminal runs and emitting tombstones; if
      not, investigate stuck pruner.
    - `pi_eng_stuck_warning_total{kind}` /
      `pi_eng_stuck_warning_false_positive_ratio` — alert when
      false-positive rate >10% / 24h AND
      `sum(pi_eng_stuck_warning_resolved_total) >= 50` over the
      same window (round 15 LOW — apply E17's min-N gate to the
      on-call alert too, not just to the canary gate; one or
      two warnings cannot page).
    - `pi_eng_capability_override_total{mode="enforce"}` — alert
      any non-zero in 24h; runbook: investigate provider/version
      skew.
    - `pi_eng_redaction_pattern_miss_total{class}` — alert ANY
      non-zero; runbook: rotate the leaked credential class
      IMMEDIATELY, patch redactor.
    - `pi_eng_phase_b_auto_disabled_total{reason}` — alert any
      non-zero in 24h; runbook: investigate slow disk / SSE
      consumer / oversaturated stream.
    Health checks: `/healthz` returns the metric snapshot + last
    capability-probe age + last successful run timestamp.

E2. **Versioned persisted schemas + pre-downgrade migrator + CI against
    actual released 2.0.x binary** (revised, round 3 MED #4 + round 4
    HIGH): existing 2.0.x readers already shipped and cannot
    understand a `schemaVersion` field they were never coded for —
    so backward-compat works one of two ways:
    (a) **Byte-compatible legacy files**: top-level structure of
        `state.json` / `events.jsonl` lines / etc. remains
        byte-identical to 2.0.x for the fields 2.0.x reads;
        `schemaVersion` and other new fields live in a clearly-named
        side-car file (`state.v2.json`, `_verdicts/` only used by
        2.1+, etc.) that 2.0.x ignores because it never opens it.
        New 2.1+ tools prefer the side-car when present, fall back
        to legacy when missing.
    (b) **Pre-downgrade migrator script** `pi engineering
        migrate-down --target 2.0.x` rewrites/removes 2.1+
        side-cars and resets any incompatible in-flight state to a
        2.0.x-readable form. The script MUST be tested in CI by
        downloading the actual 2.0.x npm tarball and running its
        binary against the migrated tree; CI fails on any read
        error, panic, or wrong output.
    All persisted artifacts MUST be classified into either
    "byte-compatible" or "side-car" — no schema field added to a
    legacy file. Rollback runbook explicitly states whether each
    active run needs to be: (a) finished on current version,
    (b) cancelled with `pi engineering run-cancel`, or (c) migrated
    via `migrate-down`. Active runs listed at
    `pi engineering rollback-readiness`. CI publishes the N/N-1
    matrix per release.

E3. **Canary success criteria for Phase B activation — with
    minimum-coverage requirements** (revised, round 3 LOW + round 4
    MED #3): Phase B remains gated by `PI_ENGINEERING_ACTIVITY_STREAM=1`
    until ALL of the following hold for two consecutive weeks on
    canary deployments, AND the canary cohort actually exercised
    representative diversity:
    - **Coverage floor** (a "rep-canary", revised round 15
      MED #1): minimum 200 completed runs total AND a minimum
      of **30 completed runs per leaf cohort** (each unique
      provider × modelId × accountFingerprint × piVersion
      tuple actually exposed by the rollout). Leaf cohorts
      with fewer than 30 runs are not gate-evaluable and the
      gate fails with a clear "insufficient leaf-cohort N"
      message. For rare leaf cohorts, the controller can
      explicitly pool same-`provider` × same-`piVersion`
      tuples per the documented pooling rule (configurable in
      `rollout.json`) and emits
      `pi_eng_cohort_pooled_total{provider}`. Failure to meet
      coverage extends the canary window — it does NOT
      auto-pass on time alone.
    - `pi_eng_activity_event_latency_ms` p95 < 250 from raw chunk
      to consumer.
    - `pi_eng_activity_drops_total{kind=tool_call_invoke|tool_call_result|error|verdict}`
      = 0; `kind=thinking` < 1k/min p99.
    - Workflow run-success rate within ±1% of pre-Phase-B
      baseline, computed per provider/modelId cohort (not just
      aggregate).
    - `pi_eng_cpu_seconds_per_run` overhead < +5% per cohort.
    - per-run activity bytes histogram p95 < 4 MB AND
      `pi_eng_activity_disk_usage_bytes` / `pi_eng_activity_disk_quota_bytes`
      < 0.85.
    - `pi_eng_stuck_warning_false_positive_ratio` < 5%.
    - `pi_eng_fallback_fired_total` per-cohort rate within ±20% of
      pre-Phase-B baseline (catches mismatch/timeout/error rate
      regressions that would otherwise hide behind the success
      delta).
    - `pi_eng_phase_b_auto_disabled_total` = 0 (item 13).
    Any miss pauses the rollout; a documented bisect-by-feature
    (turn off classifier, then queue, then redactor, then SSE)
    localizes the regression before re-enabling.

E4. **Metric catalog + cardinality budget** (revised, round 4 LOW +
    round 6 MED #2 + MED #3): a single
    `src/observability/metric-catalog.ts` declares every metric
    with its exact name, type, labels, unit, and description.
    Items 13, E1, E3, E7, item 24 import from this catalog — a
    missing series fails the build; canary-gate checker fails fast
    on undefined references. Format:
    `pi_eng_<noun>_<unit_or_total>{labels}`. **No `runId` labels
    on exported metrics** (round 6 MED #2) — `runId` is unbounded
    and would blow Prometheus/OTLP cardinality. Per-run detail
    stays in `<runsDir>/_activity/<runId>/agent-activity.jsonl`
    or as Prometheus exemplars; aggregate labels are bounded
    (provider, modelId, workflow, agent, step, kind, cohort).
    A `metric-cardinality-budget.test.ts` enforces a hard cap of
    1024 distinct label-tuple series per metric in CI; the rollout
    gate (item 24, E3) also asserts the budget holds in the canary.
    Catalog entries (canonical):
    - `pi_eng_fallback_fired_total{tier, agent, step, provider}`
      (counter)
    - `pi_eng_verdict_timeout_total{agent, step}` (counter)
    - `pi_eng_activity_queue_depth{provider}` (gauge — sampled
      max-across-runs per provider, not per-run)
    - `pi_eng_activity_drops_total{kind, provider}` (counter)
    - `pi_eng_activity_disk_bytes_per_run` (histogram — bucketed
      across runs, no per-run label)
    - `pi_eng_activity_disk_usage_bytes{surface}` (gauge — global
      E10; `surface ∈ {canonical, legacy-mirror}` so legacy-mirror
      disk visibility is in-budget for the cardinality test)
    - `pi_eng_activity_disk_quota_bytes{surface}` (gauge — global
      E10)
    - `pi_eng_activity_disk_prune_total{reason}` (counter — E10)
    - `pi_eng_activity_disk_tombstone_total` (counter — E10)
    - `pi_eng_acceptance_predicate_failed_total{step}` (counter)
    - `pi_eng_protection_block_total{path_class, rule, surface}`
      (counter — bounded label cardinality. `path_class` ∈
      `{state, events, conversation, tasks, activity, telemetry,
       verdict, capability}`, `surface` ∈ `{write, edit, delete}`.
      The raw redacted path goes to logs/exemplars only.)
    - `pi_eng_counter_wal_drops_total{reason}` (counter — round 9
      MED #3, fires when E13's WAL writer drops past quota; ANY
      non-zero is page-worthy.)
    - `pi_eng_capability_bundle_disk_bytes` (gauge — round 9 LOW,
      bytes used by `~/.pi/engineering-team/capabilities/`).
    - `pi_eng_capability_bundle_gc_total{reason}` (counter — round
      9 LOW, fires on each GC pass).
    - `pi_eng_rollout_telemetry_drops_total{reason}` (counter —
      round 10 MED #4 + round 11 MED #4; fires when the
      rollout-telemetry writer hits its daily cap).
    - `pi_eng_cohort_overflow_total{provider}` (counter — round
      10 MED #3 + round 11 MED #4; fires when the registry
      exceeds 256 tuples).
    - `pi_eng_cohort_overflow_exemplar_drops_total` (counter —
      round 11 MED #3; fires when overflow exemplars hit cap).
    - `pi_eng_stuck_warning_resolved_total{kind, outcome}`
      (counter — round 10 LOW #1 + round 11 MED #4;
      `outcome ∈ {true_stuck, false_positive, unknown}`).
    - `pi_eng_feature_gate_breach_total{feature}` (counter)
    - `pi_eng_activity_event_latency_ms` (histogram)
    - `pi_eng_activity_write_fsync_ms` (histogram)
    - `pi_eng_activity_essential_only_runs_total{reason}`
      (counter — fires when a run degrades to essential-only
      under quota pressure, per E7)
    - `pi_eng_stuck_warning_total{kind}` (counter)
    - `pi_eng_stuck_warning_false_positive_ratio` (gauge)
    - `pi_eng_capability_override_total{mode}` (counter)
    - `pi_eng_capability_mismatch_total{provider, kind}` (counter —
      a probe-bundle vs runtime mismatch was detected; `kind` ∈
      `{piVersion, piBuildHash, modelId, accountFingerprint,
        protocolVersion, runtimeFlags}`)
    - `pi_eng_capability_stale_total{provider}` (counter — a
      capability JSON exceeded staleness threshold or was
      hand-edited)
    - `pi_eng_redaction_pattern_miss_total{class}` (counter)
    - `pi_eng_phase_b_auto_disabled_total{reason}` (counter)
    - `pi_eng_cpu_seconds_per_run{cohort}` (histogram)
    - `pi_eng_workflow_success_total{workflow, cohort}` (counter)
    Catalog ships as a Markdown table alongside the runbook
    (auto-generated, per E1).

E5. **Headless metric export contract — isolated from runsDir**
    (revised, round 4 MED #2 + round 13 MED #3): CLI-only
    installs without the engineering server still emit metrics
    via one of:
    (a) `OTEL_EXPORTER_OTLP_ENDPOINT` env var → OTLP/HTTP push
        per scrape (default 60 s);
    (b) `<configDir>/telemetry/metrics.prom` file refreshed
        every scrape interval for node-exporter textfile
        collector (moved OUT of `<runsDir>` so a full or
        read-only runsDir cannot blind the disk-pressure /
        degradation signals needed for recovery);
    (c) `<configDir>/telemetry/alerts.jsonl` append-only file
        for critical-threshold breaches when no scraper is
        configured. Exporter write failures (ENOSPC / EROFS on
        configDir) ALSO fan out to a reserved emergency spool
        at `/var/tmp/pi-eng-emergency.jsonl` (configurable via
        `PI_ENGINEERING_EMERGENCY_SPOOL`) AND raise an
        independent stderr line tagged `[pi-eng-emergency]` so
        the operator can grep regardless of FS state. A
        documented `tail | grep` runbook entry covers the
        spool.
    Default behavior is (b) — zero-config for a Prometheus
    node-exporter host. The metrics emitter is the SAME library
    the server uses, so a CLI install and a server install
    produce identical metric series.
    Alert-delivery test ships in CI: a fake scraper polls the
    textfile path and asserts every cataloged metric is observable
    within 90 s of a triggering event.

E6. **Canonical rollback — standalone helper + bundled migrators**
    (revised, round 5 HIGH #2 + round 6 HIGH #1 + round 7 HIGH):
    Rollback CANNOT depend on the currently-installed extension's
    normal CLI/server boot path — a bad 2.1+/2.2+ release that
    breaks startup/imports would otherwise strand on-call. Two
    parallel entry points:
    (a) Normal path: `pi engineering rollback --to <version>` when
        the extension still boots. Uses the bundled migrator from
        the currently-installed version.
    (b) Failsafe path: `pi-engineering-rollback` — a standalone
        Node script (no extension dependencies; `#!/usr/bin/env
        node` shebang) shipped at
        `<installRoot>/scripts/rollback-standalone.mjs`. **Versioned
        + promote-after-self-test** (round 13 HIGH #1): on every
        install, the new helper is written to
        `~/.pi/engineering-team/bin/rollback.<version>` then
        runs an offline self-test (`--self-test`: parse a
        fixture, verify cached tarball checksum, dry-run
        migrator). ONLY on self-test pass does it atomically
        symlink `~/.pi/engineering-team/bin/rollback` to the new
        version. The prior version's helper remains at
        `rollback.<oldVersion>` and stays for `helperRetentionN`
        (default 3) generations. On boot-self-test failure the
        symlink is NOT advanced, preserving the last-known-good
        helper. CI test: ship a deliberately-broken
        `rollback-standalone.mjs` and assert the install fails
        the self-test, the symlink stays on the prior version,
        and rollback still completes.
        Imports only `fs`, `path`, `child_process`, and a vendored
        copy of the version-N migrator (pre-compiled, no runtime
        dependencies). Bypasses Pi-cli entirely.
    Migrator bundles are cached out-of-band at
    `~/.pi/engineering-team/migrators/<fromVersion>-to-<toVersion>.mjs`
    on every install so a corrupted extension still has the
    migration code accessible.
    **Target-version tarball caching** (round 8 HIGH #2 + round 9
    HIGH #2): every healthy install downloads and caches signed
    last-known-good target tarballs to
    `~/.pi/engineering-team/tarballs/pi-engineering-<version>.tgz`
    with sha256 checksums + GPG signatures verified on cache
    write. **Re-verify** checksum + signature IMMEDIATELY before
    install (corrupted/tampered cache caught at use-time, not
    just write-time). Cache write also records the Node binary
    used (`<runtime>/node`), npm tarball
    (`<runtime>/npm-cli.tgz`), and an `install.sh` that calls
    Node with an absolute path and unpacks the tarball without
    `npm` — pure `tar -xz` + `package.json["bin"]` symlink
    creation — so a host with damaged PATH/npm/node still
    completes rollback. The standalone rollback script ships at
    `~/.pi/engineering-team/bin/rollback` and invokes
    `~/.pi/engineering-team/runtime/node` (absolute path);
    documentation explicitly calls out invocation via absolute
    path: `~/.pi/engineering-team/bin/rollback --to <version>`.
    CI offline-rollback test runs in a `--offline`/no-network +
    PATH-stripped sandbox and asserts rollback succeeds using
    only cached migrators + tarballs + vendored Node.
    Both paths run the same sequence:
    1. Refuses without `PI_ENGINEERING_ROLLBACK_ACK=1`.
    2. **Takes the global rollback drain lock** at
       `<configDir>/.rollback.lock` (round 15 HIGH #2 — moved
       out of `<runsDir>` so a full/read-only runsDir cannot
       break failsafe rollback coordination) with an emergency
       fallback to `/var/tmp/pi-eng-rollback.lock` when
       `<configDir>` is itself unwritable. EVERY CLI and server
       spawn path checks the same `LockHelper.acquire()`
       function BEFORE starting a run; presence refuses new
       spawns with "rollback in progress, retry in N s"
       (round 10 HIGH #1). The lock is held from this point
       through step 10. CI offline rollback test asserts
       coordination still works with `<runsDir>` ENOSPC/EROFS.
    3. Invokes `rollback-readiness` (E2) — printed table.
       Healthy controllers continue running so active runs can
       progress toward `finish/cancel/migrate-down` decisions
       (round 13 HIGH #2 — fencing BEFORE readiness would strand
       workers).
    4. Blocks until each active run is terminal-or-migrated;
       `--auto-cancel` for force-abandonment. Worker subprocesses
       complete normally during this window.
    5. **Process fence** (round 11 HIGH #1, now positioned AFTER
       active-run resolution): enumerate running
       pi-engineering server/TUI/controller processes via the
       pidfile registry at `<configDir>/processes/*.pid` and the
       OS process table; send SIGTERM (then SIGKILL after a
       documented grace, default 15 s); confirm each is gone
       before proceeding. Refuses without `--allow-process-kill`
       unless the operator passed it.
    6. Runs the migrator (vendored / cached / bundled).
    7. Smoke-tests the target version's read code path against
       the actually-released target-version npm tarball.
    8. Installs the target version.
    9. Restarts the server/TUI from the newly-installed target
       version, verifies `pi engineering --version` matches
       `--to <version>`.
    10. Releases the drain lock. CI race test: attempt to start
       a run during each of steps 3–9 and assert the spawn is
       blocked with the expected error.
    **Broken-boot emergency path** (round 13 HIGH #2): when the
    current extension cannot start at all
    (`rollback-readiness` itself fails), the failsafe helper
    runs `--mark-active-runs-abandoned` which sets
    `state.json.phase="abandoned-by-emergency-rollback"` on
    every non-terminal run and proceeds to step 5–10 without
    requiring healthy controllers. Documented as a
    last-resort with explicit operator ack.
    CI:
    - Boot-failure rollback test: simulate a broken extension
      (deleted dist/, import-throw stub) and assert
      `pi-engineering-rollback` still completes successfully.
    - N→target matrix from each supported 2.1+/2.2+ to each
      supported 2.0.x target.

E7. **Phase-B chaos / load test harness** (round 5 MED #2):
    `tests/chaos/phase-b-stream.test.ts` injects failures while a
    workflow runs and asserts SLOs hold:
    - **Slow fsync** (write delayed 500ms / 2s / 5s per call):
      child stdout still drains; workflows complete; essential
      events coalesce; `pi_eng_phase_b_auto_disabled_total`
      increments at the >3-coalesce-in-60s threshold.
    - **Hung SSE consumer** (browser tab paused; consumer never
      acks): subprocess drains; in-process consumer + disk writer
      proceed; SSE backpressure shed via per-client ring not
      run-level.
    - **Saturated ring** (synthetic 100k thinking events/s):
      thinking drops, essential preserved; subprocess never
      pauses; metric counters track drops.
    - **`_activity` quota at 100%**: active-run-aware pruner (E10)
      protects active + recently-failed + operator-pinned runs;
      degrades them to essential-only; only prunes terminal
      non-pinned runs past retention; tombstones emitted per E10;
      `pi_eng_activity_essential_only_runs_total{reason="quota"}`
      and `pi_eng_activity_disk_tombstone_total` both increment.
    - **Subprocess hostile** (verbose-output canary that streams
      8 MB of `thinking` content in 1s): redactor + truncation
      hold under load; classifier doesn't OOM; queue depth metric
      reflects pressure. CI gates a Phase-B release.

E8. **Atomic + multi-process-safe metrics textfile — isolated**
    (revised, round 5 MED #3 + round 15 HIGH #1): the textfile
    path from E5 is written write-temp-and-rename per scrape
    interval to `<configDir>/telemetry/metrics.prom.<pid>.<seq>`
    (moved out of `<runsDir>`) then atomically renamed to
    `metrics.prom.<pid>`. A periodic aggregator (single per-host
    owner via flock at `<configDir>/telemetry/.aggregator.lock`)
    merges per-pid fragments into the single `metrics.prom`
    under the same `<configDir>/telemetry/` path that node-
    exporter reads, with stale-file GC (>10× scrape interval
    since last update). CI: ENOSPC/EROFS on `<runsDir>` while
    asserting the textfile is still being updated and node-
    exporter scrapes succeed. Concurrent CLI/server emitters write to their own
    fragment; only the aggregator owns the canonical file.
    Concurrent-emitter alert-delivery test ships in CI: two
    fake CLI processes + one fake server emit overlapping
    metric updates and a fake scraper asserts no partial scrapes
    are observable.

E9. **Per-spawn capability re-check** (round 7 MED #2): boot-time
    capability lookup is insufficient for a long-lived server. The
    orchestrator computes a lightweight `runtimeFingerprint` BEFORE
    every subprocess spawn:
    `sha256(realpath(piBinary) + piVersion + piBuildHash +
    accountFingerprint + protocolVersion + sortedRuntimeFlags)`.
    Compare to the matched capability JSON's recorded fingerprint.
    On mismatch:
    - `enforce`: re-probe inline (cached for 5 min) before
      spawning; refuse spawn if re-probe still mismatches.
    - `warn`: log + increment `pi_eng_capability_mismatch_total{...}`
      + proceed.
    - `observe`: log only.
    The `pi` binary is resolved via `realpath` of `which pi` to
    catch PATH swaps. CI test: change the `pi` symlink between
    consecutive spawns and assert the mismatch counter fires and
    the gate behaves per mode.

E10. **Global activity-disk metrics + active-run-aware pruning**
    (round 7 MED #3 + MED #4): per-run histograms cannot tell when
    the SHARED `_activity` quota is near full. Add to the catalog
    (E4):
    - `pi_eng_activity_disk_usage_bytes` (gauge — total bytes used
      under `<runsDir>/_activity/`)
    - `pi_eng_activity_disk_quota_bytes` (gauge — configured cap)
    - `pi_eng_activity_disk_prune_total{reason}` (counter)
    - `pi_eng_activity_disk_tombstone_total` (counter)
    Page on `usage/quota > 0.85`; the alert is on the ratio of
    the global gauges, NOT per-run histograms. Chaos test (E7)
    asserts the alert fires at the threshold.
    Pruning policy (revised):
    1. Active or running-recently-failed (last `incidentPinTTL`,
       default 7d) runs are NEVER pruned outright. Under quota
       pressure they degrade to `essential-only` mode in the
       activity ring (counter
       `pi_eng_activity_essential_only_runs_total{reason="quota"}`
       increments) and their existing activity logs are rotated +
       compressed (gz), not deleted.
    2. Operator can pin a run with
       `pi engineering run-pin <runId> [--ttl=Nd]` adding it to
       `<runsDir>/_activity/.pinned.json`. Pinned runs are
       protected from prune for the TTL.
    3. Terminal, non-pinned, age-past-retention runs are pruned
       oldest-first. Each prune emits a tombstone at
       `<runsDir>/_activity/.tombstones/<runId>.json`
       (`{runId, prunedAt, reason, bytes, lastSeq}`) so replay
       gives an explicit "pruned, see tombstone" error rather
       than a silent missing-file.

E11. **Monotonic-counter contract for headless exporter** (round 7
    MED #5): the per-pid textfile fragments from E8 are NOT
    counter-safe across process restart — a CLI invocation exits
    and its fragment is GC'd, making `*_total` counters drop.
    Fix: a host-level `pi_eng_counter_wal.jsonl` (rotated daily)
    is the SOURCE OF TRUTH for every counter. Each CLI/server
    process appends its delta on emit. The aggregator (E8) reads
    the WAL plus per-pid gauges, never trusts ephemeral
    counters from short-lived processes. CI restart/exit test:
    spawn 100 short-lived CLI processes each incrementing a
    cataloged counter once, kill them, restart the aggregator,
    and assert the exported counter total equals 100 and stays
    monotonic across the test.

E12. **N/N-1 skew matrix for every client/server pairing** (round 7
    MED #6 + round 8 MED #3): CI publishes a skew matrix proving
    each pairing works:
    - Old CLI (2.0.x) ↔ new server (2.1+): two options selected
      per cohort by `PI_ENGINEERING_LEGACY_MIRROR`:
      (a) **Host-owned regular-file fanout** (default): the
          `RunActivityQueue` writes each event to BOTH
          `_activity/<runId>/agent-activity.jsonl` AND a capped
          mirror at the EXACT legacy filename
          `<runDir>/agent-activity.jsonl` (round 10 HIGH #2 —
          the 2.0.x CLI hardcodes this path; mirror MUST match).
          Mirror is owned by the same host process and inherits
          the same quota / pruning / tombstoning / protection
          policies as the canonical file (item 9 protection
          list extended; new write attempt from an agent to
          this path is still blocked). **Mirror bytes count
          toward the global `_activity` quota** (round 11
          HIGH #3) — the disk-usage gauge sums BOTH surfaces
          (`pi_eng_activity_disk_usage_bytes{surface}` from E4);
          the pruner sees both surfaces in one accounting; a
          runaway mirror cannot fill `<runsDir>` while canonical
          gauges stay green. **Quota-vs-filesystem distinction**
          (round 13 LOW): LOGICAL `_activity` quota exhaustion
          NEVER refuses new runs — it degrades runs to essential-
          only and tombstones (E10). Only REAL filesystem-full
          (`ENOSPC` on `<runsDir>`) refuses new runs with a clear
          `runsdir-full` error. Chaos/skew tests split:
          quota-exhaustion asserts essential-only + tombstones;
          ENOSPC asserts spawn refusal + alert firing. NOT a
          symlink or
          hardlink — those would defeat storage isolation and
          let pruned bytes stay alive (round 9 MED #1).
          CI test: the actually-released 2.0.x CLI binary tails
          a new-server run and sees streamed events.
      (b) **Explicit downgrade**: if the operator sets
          `PI_ENGINEERING_LEGACY_MIRROR=disabled`, old CLIs see
          a clear "this server runs Phase B; old CLI cannot
          stream — upgrade or use the dashboard" message via
          `/healthz?features` rather than a missing file. Mirror
          metadata exposes a `surface=legacy-mirror` label on
          `pi_eng_activity_disk_usage_bytes`.
    - New CLI (2.1+) ↔ old server (2.0.x): CLI probes
      `/healthz?features` first; if Phase B is unsupported it
      shows "activity stream not available on server vX.Y.Z";
      rollback-readiness still functions because it only reads
      legacy state files.
    - Mixed dashboard: protocol header pins; old browser tab sees
      degraded view; new tab sees full Phase B.
    - Tail / replay / `/healthz` / rollback-readiness each run
      against an N-1 peer in the matrix, using the actual
      released 2.0.x binary on one side.
    Each pairing has an explicit graceful-fallback path
    documented in the protocol versioning header (item 14).
    Matrix runs on every release in CI; a missing pairing
    fails the release.

E13. **Counter WAL safety + isolation** (round 8 MED #4): the
    counter WAL from E11 is itself a potential disk/IO blast
    radius. Hardening:
    - **In-process aggregation**: every process accumulates
      counter deltas in memory for up to `walFlushIntervalMs`
      (default 5000) then writes ONE aggregated WAL line, so a
      counter incremented 100k times in one second produces one
      append, not 100k.
    - **Storage isolation**: WAL lives at
      `<configDir>/telemetry/counter-wal.jsonl` (NOT `runsDir`)
      so it cannot fill the activity quota or compete with run
      state. Dedicated daily quota `walMaxBytes` (default 256 MB)
      enforced by the aggregator; over-quota triggers immediate
      compact + rotate, and beyond 2× quota the WAL writer drops
      with `pi_eng_counter_wal_drops_total` counter.
    - **Checkpoint + compaction**: aggregator runs hourly,
      collapses all WAL deltas into a checkpoint
      `<configDir>/telemetry/counter-checkpoint.json`, and
      truncates the WAL to entries after the checkpoint sequence.
      Compaction is atomic (write-tmp-rename + fsync).
    - **Counter-storm chaos test** (CI): 10 fake CLIs each
      increment a cataloged counter 1M times in 10s; assert
      WAL size stays under quota, aggregator output stays
      monotonic, no `runsDir` writes, no workflow stall.

E14. **Honeytoken canary-secret detector** (round 8 LOW): a
    standalone scanner `src/observability/honeytoken-scanner.ts`
    runs once per `honeytokenScanIntervalMs` (default 60 s)
    across persisted JSONL (`agent-activity.jsonl`,
    `_telemetry/*.jsonl`, `_verdicts/`), SSE broadcast history,
    replay outputs, and retry-prompt excerpts. The scanner uses
    a pre-seeded set of canary secrets injected into probe runs
    AND a separate at-rest pattern-detector that runs the same
    redaction regexes from item 18 — if it finds a match in
    persisted output, the redactor missed.
    `pi_eng_redaction_pattern_miss_total{class}` increments;
    page-worthy ANY non-zero count. Sampled output (with the
    leaked content itself redacted) goes to
    `<configDir>/telemetry/honeytoken-alerts.jsonl` with a
    runbook entry treating any hit as a credential-leak
    incident (rotate the credential class, patch the redactor,
    re-deploy).

E15. **Bounded cohort registry** (round 10 MED #3): a static
    `src/observability/cohort-registry.ts` maps high-cardinality
    dimensions (provider × modelId × accountFingerprint ×
    piVersion) to a bounded `cohort` label suitable for export.
    Up to 256 cohort buckets, allocated lazily as new tuples
    appear; the (tuple → cohort id) mapping is persisted to
    `<configDir>/cohort-registry.json` for cross-process
    consistency. Overflow (>256 distinct tuples) tail-cohorts as
    `cohort=overflow` with a paging metric
    `pi_eng_cohort_overflow_total{provider}`. **Overflow is a
    HARD ramp blocker** (round 11 MED #3): if
    `pi_eng_cohort_overflow_total > 0` for any provider, every
    feature-gate ramp pauses until overflow is investigated and
    the registry is expanded (config bump or stricter tuple
    dimensions). While overflow exists, the controller ALSO
    persists a full-fidelity per-run exemplar at
    `<configDir>/telemetry/overflow-exemplars.jsonl` so the
    offline rollup can join overflow runs back to their full
    `(provider, modelId, accountFingerprint, piVersion)` tuple
    when computing canary gates. Exemplars rotate daily with a
    32 MB/day cap; over-cap drops increment
    `pi_eng_cohort_overflow_exemplar_drops_total` (any non-zero
    is page-worthy). A separate offline rollup script joins
    exported `cohort` labels back to the full tuple via the
    registry for canary-gate evaluation, keeping export labels
    bounded while canary checks remain dimension-aware. CI
    fails if any canary-gate referenced dimension is not
    derivable from the registry.

E16. **Minimal always-on rollout-telemetry path** (round 10 MED #4):
    a small fixed subset of metrics — `pi_eng_workflow_success_total`,
    `pi_eng_fallback_fired_total`, `pi_eng_verdict_timeout_total`,
    `pi_eng_capability_*`, `pi_eng_feature_gate_breach_total`,
    `pi_eng_protection_block_total` — is emitted via a separate
    `rollout-telemetry.jsonl` writer that bypasses
    `PI_ENGINEERING_TELEMETRY=0` and `PI_ENGINEERING_LEGACY_MODE`.
    Storage: append-only at
    `<configDir>/telemetry/rollout.jsonl`, daily rotation, cap
    32 MB/day per host. **Drops are fail-closed** (round 13
    MED #4): on cap reach OR any rollout-writer error, the
    controller (a) increments
    `pi_eng_rollout_telemetry_drops_total{reason}`,
    (b) ALSO writes the drop signal to the counter WAL (E11)
    AND the emergency spool (E5) so the signal survives a
    rollout-telemetry FS failure, and (c) AUTOMATICALLY
    blocks every feature-gate ramp and pages on-call until
    the drop counter returns to zero for `recoveryWindowSec`
    (default 900). Documented: `LEGACY_MODE` operators get
    observability degradation ONLY for the verbose telemetry
    path (activity stream, full fallback bodies); rollout-
    control signals remain visible. CI test runs auto-disable
    / canary gate decisions with `PI_ENGINEERING_TELEMETRY=0`
    and asserts they still fire on threshold breach; a
    separate test fills the rollout cap and asserts ramps are
    blocked + emergency spool catches the drop signal.

E17. **Stuck-warning false-positive accounting** (round 10 LOW #1):
    `pi_eng_stuck_warning_false_positive_ratio` is now a derived
    metric from two explicit counters:
    - `pi_eng_stuck_warning_total{kind}` (fires when the
      detector emits a `stuck-warning` event).
    - `pi_eng_stuck_warning_resolved_total{kind, outcome}` where
      `outcome ∈ {true_stuck, false_positive, unknown}`, set by:
      - `true_stuck` if the agent failed-with-no-verdict OR the
        subprocess died within `falsePositiveWindowSec` (default
        120s) of the warning;
      - `false_positive` if the agent emitted a verdict within
        the window (the warning was premature);
      - `unknown` if the run was cancelled / aborted by an
        external signal.
    Ratio = `false_positive / total`. Canary gate fails on
    `ratio > 0.05` AND a minimum N=50 stuck warnings (no
    "green by construction" with zero data). Operator-dismissal
    signal optional via `pi engineering ack-warning <runId>`
    counted under `outcome=false_positive`.

## Phase D — Verification

22. **Capability-aware integration test matrix**: a CI matrix runs
    each workflow (triage, fix-loop, debug, investigate, doc-backfill,
    migration, refactor-campaign, verify, issue-analyze,
    plan-build-review, spec-plan-build-review, consult) against
    fixture capability JSONs: `full-tool` (Anthropic-like),
    `copilot-like` (write+edit+read, no SendMessage), `minimal`
    (read only). Assertions: full-tool PASS end-to-end; copilot-like
    PASS via documented fallbacks; minimal emits
    `provider-missing-capability` upfront for any step that needs
    write/edit and never spawns a worker.

23. **Manual QA on the real CoPilot machine** — capability-aware:
    `scripts/copilot-smoke.sh` runs Phase 0a probes first to
    establish baseline capabilities, then drives
    triage → fix-loop → verify. Assertions per agent per step are
    capability-aware: require the events that the measured
    provider stream actually produces; no false-fail when the
    provider has no `thinking` events.

24. **Phased rollout + per-feature cohort flags + kill switches**
    (revised, round 3 HIGH + LOW + round 5 HIGH #1 + HIGH #2 +
    round 8 HIGH #1): Phase A's BEHAVIOR-CHANGING items each ship
    behind individual feature flags with cohort-based staged
    rollouts, NOT default-on in 2.1.0. Each flag has its own
    per-cohort SLO gate and auto-disable:
    - `PI_ENGINEERING_VERDICT_SLOT_HOSTOWNED` (item 4) — 0%
      cohort default; ramps 1% → 10% → 50% → 100% on per-cohort
      SLO pass (workflow success delta within ±1%,
      `pi_eng_verdict_timeout_total` within ±20% of baseline).
    - `PI_ENGINEERING_ACCEPT_PREDICATES` (item 8) — same ramp;
      gate adds `pi_eng_acceptance_predicate_failed_total{step}`
      cohort delta.
    - `PI_ENGINEERING_FORCED_RETRIES` (items 5, 6) — same ramp;
      gate adds per-cohort wall-time p95 delta < +10%.
    - `PI_ENGINEERING_TELEMETRY` (item 7, E5, E11) — same ramp;
      gate adds `_telemetry` disk usage cap < 0.5% of runsDir.
    - `PI_ENGINEERING_EXPANDED_STATE_PROTECTION` (item 9) — same
      ramp; gate adds `pi_eng_protection_block_total` ≤ baseline
      (a spike means workflows broke).
    - `PI_ENGINEERING_CAPABILITY_MODE` — three-state observe/
      warn/enforce as documented; default `warn` only after the
      above features hit 100% cohort.
    A central rollout-controller config
    `<configDir>/rollout.json` declares the cohort % per feature
    per provider/account; the controller refuses to spawn at a
    cohort that pushes beyond the declared %. **Feature decisions
    are frozen per run** (round 10 MED #2): at run start the
    controller computes a deterministic feature-decision vector
    from a stable cohort key
    (`hash(runId + provider + modelId + accountFingerprint)`)
    and persists it to `<runDir>/feature-decisions.json`. Every
    step of that workflow reads the SAME vector; `rollout.json`
    edits and auto-disable events only affect NEW runs (or an
    explicit cancel + restart). A run cannot have verdict slots
    on for step 1 and off for step 2. **Breach protocol for
    already-running unsafe runs** (round 11 HIGH #2): on
    `pi_eng_feature_gate_breach_total` increment, the controller
    enumerates active runIds whose frozen vector includes the
    breached feature, then either (a) pauses each at the next
    step boundary with `state.json.pauseReason=
    "gate-breach-<feature>"` and a runbook command
    `pi engineering resume-or-abort <runId>`, OR (b) hot-degrades
    the feature to its declared Phase-safe equivalent for the
    remaining steps when one exists (e.g. verdict slots →
    legacy `_agent_tmp`-style path; acceptance predicates →
    "warn" mode). Each feature in item 24 declares its breach
    behavior in `rollout.json`. CI test triggers a mid-workflow
    breach and asserts active runs pause or degrade per declared
    policy. Cohort key uses a STABLE host/account+RUNTIME
    identifier (round 11 MED #2 + round 13 MED #2):
    `hash(provider + modelId + accountFingerprint + piVersion +
    piBuildHash + hostId)` where
    `hostId = sha256(machineId + installPath)`. Including
    `piVersion + piBuildHash` means a canaried account on an
    untested Pi build does NOT inherit prior cohort exposure —
    the new runtime fingerprint must satisfy its own coverage +
    SLO gates before any ramp applies. Per-run frozen decision
    derives from this stable key, NOT `runId`. Affected accounts
    surface in the rollback runbook via
    `pi engineering cohort-report --feature <name>` with both
    account-level and runtime-fingerprint-level breakdowns.
    Rollout-control
    telemetry — capability mismatch counters, workflow
    success/failure, fallback fired, verdict timeout, feature
    gate breach — is **ALWAYS-ON**, not behind any of the gated
    features (round 9 HIGH #1). Each ramp requires per-feature
    soak: minimum 200 runs OR 7 days at the current cohort %,
    whichever is later, AND coverage across ≥3 providers × 2
    models × 2 accounts × 2 piVersions before advancing. Failure
    to meet coverage extends the soak; no ramp on time alone.
    Auto-disable: any feature's cohort gate failing
    (`pi_eng_feature_gate_breach_total{feature}` > 0 in 1h)
    rolls that feature's cohort back to the prior % and pages.
    Phase B (Activity Stream) is its own
    `PI_ENGINEERING_ACTIVITY_STREAM` flag with the same ramp +
    E3 criteria.
    Kill switches:
    - `PI_ENGINEERING_LEGACY_MODE=2.0.x` (round 6 HIGH #2 — the
      "real" kill switch): bypasses ALL Phase A behaviors at boot
      EXCEPT the minimal always-on rollout-telemetry writer (E16),
      which is an explicit, documented out-of-band exception
      (round 11 MED #1). The legacy-parity CI suite asserts
      byte-for-byte equivalence on every other surface —
      `state.json`, `events.jsonl`, `_verdicts/`, `_telemetry/`
      (verbose), schema sidecars — against the actually-released
      2.0.x binary, but explicitly EXCLUDES the rollout-telemetry
      file from the comparison. A separate
      `PI_ENGINEERING_EMERGENCY_NO_NEW_WRITES=1` super-mode is
      documented for incident operators who need a truly
      observation-only stance (no rollout-telemetry writer
      either), at the cost of losing rollout-control visibility.
    - `PI_ENGINEERING_CAPABILITY_MODE=observe`: narrower — only
      disables the capability matrix gate; other Phase A features
      remain active.
    - `PI_ENGINEERING_ACTIVITY_STREAM=0`: disables Phase B
      end-to-end; Phase A unaffected.
    Per-behavior toggles are documented for finer control:
    `PI_ENGINEERING_VERDICT_SLOT_HOSTOWNED=0`,
    `PI_ENGINEERING_ACCEPT_PREDICATES=0`,
    `PI_ENGINEERING_FORCED_RETRIES=0`,
    `PI_ENGINEERING_TELEMETRY=0`.
    **Kill-switch runtime lifecycle** (round 13 MED #1): all
    env-var toggles are watched by a `KillSwitchPoller`
    (default poll interval 5 s) that re-reads
    `<configDir>/kill-switches.env` (operator-edited file with
    higher precedence than env at process start). On a flip
    from on → off:
    - **New spawns** immediately respect the new value via
      their frozen feature-decision vector.
    - **Active Phase B runs**: SSE pauses, classifier short-
      circuits to no-op, activity ring drains existing events
      then stops appending (data preserved up to the flip).
    - **Active Phase A runs**: each feature declares a runtime
      response — `pause-at-step-boundary` (with
      `pauseReason="kill-switch-<feature>"`), `degrade-now`
      (hot-switch to the declared Phase-safe equivalent), or
      `complete-then-disable` (let the current step finish on
      the old behavior, no new steps on the disabled
      behavior). Default per feature is documented in
      `rollout.json`.
    CI test asserts kill-switch latency from file edit to
    behavior change is under 10 s without any process restart. Rollback runbook is canonical and single-path
    (item E6 — supersedes the inline guidance previously in item 1
    and E2): NEVER `pnpm install` last-known-good before
    `pi engineering rollback-readiness` has been run and active-run
    decisions (finish / cancel / migrate-down) executed.

## Changelog

### Round 1 (Codex)
**Accepted (incorporated):**
- HIGH #1: Replaced "probe-driven local-registry inventory" with a
  Phase 0 observed-capability-probe harness and a capability matrix
  (new items 0a, 0b, 1).
- HIGH #2: Moved verdict-file fallback out of `_agent_tmp` to
  `<runDir>/_verdicts/...` and added a narrowly-scoped Layer-A
  exception keyed on `PI_ENGINEERING_VERDICT_FILE` (item 4). Edit
  fallback covered by the same item.
- HIGH #3: Reversed the "strip provider prefixes" item. Now
  preserves explicit `provider/model`, resolves bare aliases via
  Pi model-list with a provider-preference list, hard-fails on
  no candidate (item 3).
- HIGH #4: Added Phase 0b stream-source survey so Phase B builds
  on the proven source per provider, not assumed stdout (items
  0b, 11). UI degrades gracefully when realtime is impossible.
- HIGH #5: Centralized redaction in `src/team/Redactor.ts` covering
  EVERY body — tool calls, results, assistant text, stdout/stderr
  chunks, retry prompts, replay logs (item 18).
- MED #6: Separated in-process TUI callback from optional browser
  SSE; defined server lifecycle, healthcheck, protocol versioning
  (item 14).
- MED #7: Single `RunActivityQueue` append queue with monotonic
  seq AND retained source timestamps; replaces bare per-runtime
  sequence numbers (item 13).
- MED #8: Forced retries respect absolute step deadline and pass
  only redacted bounded excerpts through the central redaction
  pipeline (items 5, 6).
- MED #9: Replaced character-count synthesis check with per-step
  `acceptPass` predicates over required artifacts/sections;
  escalates to FAIL after retry exhaustion instead of looping
  NEEDS_MORE (item 8).
- MED #10: Stuck detector distinguishes `model-silent`,
  `tool-running`, `pipe-buffered`, `dead-child` (item 16).
- LOW #11: Per-event body cap applied BEFORE classification,
  render, redaction, JSONL append (item 19).
- LOW #12: Smoke-test assertions are capability-aware; no
  false-fail on providers without `thinking` events (item 23).

**Rejected:** (none — every finding was material and incorporated.)

### Round 2 (Codex — security and data-integrity review)
**Accepted (incorporated):**
- HIGH #1: `agent-activity.jsonl`, `_telemetry/`, `_verdicts/` added
  to Layer-A `isProtectedPath` orchestrator-owned list with tamper
  tests (item 9). Host process is sole writer via
  `RunActivityQueue` and telemetry writer.
- HIGH #2: SSE + tail now require an unguessable per-runtime bearer
  token, strict run-id UUIDv4 regex, realpath-rooted-under-runsDir
  resolution, and default localhost-only bind (items 14, 15).
- HIGH #3: Verdict-file slot is host pre-created with O_NOFOLLOW,
  Layer-A exception keyed on the canonical-path + inode + agent +
  step + token tuple, atomic seal after host reads it, later writes
  refused (item 4).
- MED #4: `RunActivityQueue` upgraded to durable single-owner: flock
  per-run lock, persisted seq across resume, O_APPEND + fsync at
  lifecycle boundaries, partial-line replay handling (item 13).
- MED #5: Redaction order corrected to **redact-then-truncate** with
  256-byte rolling boundary overlap so boundary-straddling secrets
  still match (items 18, 19).
- MED #6: ANSI/OSC strip for CLI/TUI; JSON-encode for SSE;
  HTML-escape for dashboard; trusted metadata renders outside
  untrusted body to prevent spoofed prefix impersonation (item 18).
- MED #7: Probe runs in isolated `mktemp -d`/probe-runDir with
  canary files, stubbed approval/secret/SendMessage channels, and
  network restriction; redacted evidence bundle retained, dir wiped
  on success / `.failed`-suffixed on error (item 0a).
- MED #8: Acceptance predicates promoted to host-executed,
  workflow-specific (test exit code, file changes, severity tag,
  required sections); synthesized verdicts tagged
  `provenance: "synthesized"` and treated NON-AUTHORITATIVE for
  safety-gating steps (item 8).
- LOW #9: Capability JSONs validated against TypeBox schema, MUST
  carry provenance fields tied to pi version+build hash and the
  probe bundle hash; stale or hand-edited matrices hard-fail unless
  explicit operator override (item 1).

**Rejected:** (none — every finding was material and incorporated.)

### Round 3 (Codex — ops and SRE review)
**Accepted (incorporated):**
- HIGH: Phase A no longer hard-fails by default. Added
  `PI_ENGINEERING_CAPABILITY_MODE` with `observe`/`warn`/`enforce`,
  default `warn` on 2.1.0, flipping to `enforce` only after canary
  cleanup. Bundled baseline capability JSONs ship so a fresh
  install in `enforce` works without a manual probe. Emergency
  downgrade path documented (item 1, item 24).
- MED #1: Capability provenance now includes `modelId`,
  `accountFingerprint`, `piEngVersion`, `protocolVersion`, and
  `runtimeFlags[]` so model/account/CLI/protocol/flag drift
  triggers re-probe or fail-closed in `enforce` (item 1).
- MED #2: `RunActivityQueue` is a BOUNDED async ring (4 096 events
  / 8 MB) with kind-aware drop semantics — `thinking` and
  `pipe-buffered` drop first under pressure, essential kinds back-
  pressure the subprocess. Per-run 64 MB disk quota with gz
  rotation and global runsDir quota with refuse-new-runs.
  Metrics exposed (item 13, E1).
- MED #3: Full observability surface added in Phase E (new
  section): structured metrics with default alert thresholds,
  runbook entries for each failure mode, `/healthz` endpoint,
  page-able paths for capability override, redaction misses,
  stuck-warning false positives, fallback spikes, disk pressure
  (item E1).
- MED #4: Versioned persisted schemas, N/N-1 cross-read CI
  matrix, documented rollback runbook with three explicit
  modes (finish / cancel / migrate-down) and a
  `rollback-readiness` CLI. (item E2).
- LOW: Phase B canary success criteria pinned to numeric
  thresholds: p95 stream latency, essential-event drop rate,
  workflow success delta, CPU overhead, disk per run,
  false-stuck rate — with a bisect-by-feature regression
  procedure if any criterion misses (item E3).

**Rejected:** (none — every finding was material and incorporated.)

### Round 4 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH: Rollback no longer adds `schemaVersion` to legacy files
  that 2.0.x readers expect byte-stable. Two-path policy: either
  byte-compatible legacy file + side-car for new fields, OR a
  pre-downgrade `migrate-down` script tested in CI against the
  actually-released 2.0.x npm tarball binary (item E2).
- MED #1: `RunActivityQueue` no longer back-pressures the
  subprocess on any kind. Essential kinds COALESCE into a summary
  line; if essential-coalescing fires >3× in 60s, Phase B
  auto-disables for the rest of the run. Producer-side stdout
  drain is fully decoupled from disk/UI consumers (item 13).
- MED #2: Headless metric export contract added (E5): OTLP push,
  textfile-exporter, or `pi_eng_alerts.jsonl` append. CLI installs
  ship identical metric series to server installs; alert-delivery
  CI test required.
- MED #3: Canary gates now require a **rep-canary** coverage
  floor — minimum 200 runs across ≥3 providers × 2 models × 2
  accounts × 2 piVersions — before the time-based two-week window
  can satisfy any criterion (E3). Per-cohort thresholds replace
  aggregate ones for success delta, CPU, and fallback rate.
- MED #4: Activity storage moved out of `<runDir>/` to
  `<runsDir>/_activity/<runId>/`, isolating Phase-B disk usage
  from core run state. Global quota exhaustion prunes oldest
  activity logs instead of refusing new RUNS (item 13).
- LOW: `src/observability/metric-catalog.ts` is the single source
  of truth; items 13, E1, E3 import names from it; missing series
  fails the build; canary-gate checker fails fast on undefined
  references (item E4).

**Rejected:** (none — every finding was material and incorporated.)

### Round 5 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH #1: Phase A `warn → enforce` default flip now requires the
  E3-style representative coverage floor + per-cohort zero on
  capability override / mismatch / staleness, plus fallback and
  timeout rate envelopes (item 24). Time-based pass alone is
  insufficient.
- HIGH #2: Rollback guidance unified behind a single canonical
  command/runbook E6 (`pi engineering rollback --to <version>`),
  with required ack + readiness + active-run resolution + migrator
  + dry-run smoke-test before install. Items 1 and 24 cross-link
  rather than restating conflicting flows.
- MED #1: Activity layout helper `getActivityPaths(runId)` is the
  single resolution surface; tail/replay/protection/SSE all import
  from it; legacy path still tailable for in-flight runs;
  upgrade/downgrade tests cover both layouts (item 14).
- MED #2: Phase-B chaos/load harness (`tests/chaos/phase-b-stream.test.ts`)
  injects slow fsync, hung SSE, saturated rings, full quota, and
  hostile verbose subprocess; gates Phase-B release in CI (item E7).
- MED #3: Headless `metrics.prom` is now per-pid fragments
  atomically write-temp-and-renamed, merged by a single
  flock-owned aggregator with stale-file GC. Concurrent-emitter
  CI test required (item E8).
- LOW: E1 alert thresholds reference exact catalog symbols from
  E4 (`pi_eng_*` prefix); runbook Markdown is GENERATED from the
  catalog + threshold table; build fails on missing-symbol
  references (item E1).

**Rejected:** (none — every finding was material and incorporated.)

### Round 6 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH #1: Rollback now runs the CURRENTLY-INSTALLED version's
  bundled `migrate-down` (which knows about its own sidecars)
  BEFORE installing the target. Smoke-test exercises the target
  version's read code path. CI matrix proves rollback from each
  2.1+/2.2+ to each 2.0.x target (item E6).
- HIGH #2: Added `PI_ENGINEERING_LEGACY_MODE=2.0.x` — the real
  kill switch that disables ALL Phase A behaviors (capability
  gate, verdict slots, host predicates, retry/timeout deltas,
  telemetry, expanded state protections, sidecars). CI "legacy
  parity" suite asserts byte-for-byte equivalence to released
  2.0.x. Per-behavior toggles also documented (item 24).
- MED #1: CLI tail (item 15) now uses `getActivityPaths(runId)`
  same as SSE/replay; no raw path concatenation remains in the
  plan; legacy `<runDir>/agent-activity.jsonl` fallback explicit.
- MED #2: Removed `runId` labels from exported metrics — `runId`
  is unbounded. Per-run detail stays in JSONL/exemplars; bounded
  labels (provider/modelId/workflow/agent/step/kind/cohort).
  Added `metric-cardinality-budget.test.ts` enforcing 1024
  series/metric; rollout gate asserts the budget in canary (E4).
- MED #3: Added every previously-referenced-but-missing series
  to the catalog: `pi_eng_capability_mismatch_total{provider,kind}`,
  `pi_eng_capability_stale_total{provider}`,
  `pi_eng_activity_essential_only_runs_total{reason}` (E4).
- LOW: SSE + tail use the existing centralized `isSafeRunId()`
  predicate, not a UUID-only regex; legacy/manual/test runs
  remain tailable (items 14, 15).

**Rejected:** (none — every finding was material and incorporated.)

### Round 7 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH: Rollback no longer depends on the broken extension's
  boot path. Added standalone `pi-engineering-rollback` script
  copied on every install to `~/.pi/engineering-team/bin/rollback`
  + vendored migrator caches at `~/.pi/engineering-team/migrators/`.
  CI boot-failure test simulates broken extension and asserts
  failsafe rollback still completes (item E6).
- MED #1: Item 1 stale "observe restores 2.0.x" wording replaced
  with explicit pointer to `PI_ENGINEERING_LEGACY_MODE=2.0.x`;
  CI fails the doc build if the old wording resurfaces.
- MED #2: Per-spawn capability re-check via `runtimeFingerprint`
  (sha256 of pi binary realpath + version + buildHash + account +
  protocolVersion + sorted runtimeFlags); mismatch behavior gated
  by mode; new metric `pi_eng_capability_mismatch_total` emitted;
  CI proves PATH/symlink swap triggers the gate (item E9).
- MED #3: Added global `pi_eng_activity_disk_usage_bytes` +
  `pi_eng_activity_disk_quota_bytes` gauges to catalog; page on
  the ratio not per-run histograms; chaos test asserts threshold
  firing (item E10).
- MED #4: Prune policy rewritten: active and recently-failed runs
  (last `incidentPinTTL`, default 7d) NEVER pruned; degrade to
  essential-only under quota; manual `pi engineering run-pin`
  command; tombstone emit on every prune so replay gives an
  explicit error (item E10).
- MED #5: Counter monotonicity through host-level
  `pi_eng_counter_wal.jsonl` source-of-truth; aggregator never
  trusts ephemeral per-pid counters; CI restart/exit test proves
  counter survives 100 short-lived processes (item E11).
- MED #6: Explicit N/N-1 skew matrix (CLI/server/dashboard/
  tail/replay/healthz/rollback-readiness pairings); protocol-
  versioned graceful fallback for each; missing pairing fails
  release (item E12).

**Rejected:** (none — every finding was material and incorporated.)

### Round 8 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH #1: Phase A no longer ships behavior-changing items
  default-on. Each item (verdict slots, host predicates, retry/
  timeout, telemetry, expanded state protection) is behind its
  own cohort feature flag with per-cohort SLO gates and
  auto-disable on `pi_eng_feature_gate_breach_total` (item 24).
- HIGH #2: Failsafe rollback now caches signed last-known-good
  target npm tarballs at install time under
  `~/.pi/engineering-team/tarballs/`; installs from cache, no
  network needed. Offline-rollback CI test runs in `--offline`
  sandbox (item E6).
- MED #1: Removed "current 2.0.x-compatible behavior" wording
  from item 1's observe-mode description; explicit pointer to
  `PI_ENGINEERING_LEGACY_MODE=2.0.x`. Docs build fails on the
  old wording (item 1).
- MED #2: Updated E1, E3, E4, E7, item 13 references to use the
  global `pi_eng_activity_disk_usage_bytes` /
  `pi_eng_activity_disk_quota_bytes` gauges and E10's
  active-run-aware pruning + tombstones; removed stale
  per-run/oldest-first language everywhere.
- MED #3: Skew matrix now defines a concrete legacy bridge —
  new server maintains a byte-compatible mirror at
  `<runDir>/agent-activity.jsonl` (symlink/hardlink to the
  `_activity` location) so old CLIs still find the file (E12).
- MED #4: Counter WAL hardened with in-process aggregation,
  storage isolation under `<configDir>/telemetry/`, dedicated
  daily quota, atomic checkpoint + compaction, counter-storm
  chaos test (E13).
- LOW: Honeytoken canary-secret detector added (E14): scans
  every persisted/streamed/replayed body against the same
  redaction patterns; any hit pages as a credential-leak
  incident with redacted evidence.

**Rejected:** (none — every finding was material and incorporated.)

### Round 9 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH #1: Rollout-control telemetry (capability mismatches,
  workflow success, fallback fired, verdict timeout, feature
  gate breach) is ALWAYS-ON regardless of any other Phase A
  gate. Each ramp requires E3-style coverage AND a 200-run /
  7-day soak per cohort before advancing (item 24).
- HIGH #2: Failsafe rollback uses absolute paths for the
  rollback binary and a vendored Node runtime at
  `~/.pi/engineering-team/runtime/node`; cached tarballs are
  re-verified (checksum + signature) at install time, not just
  cache-write time; pure `tar -xz` unpacking avoids npm
  dependency. CI offline test includes PATH-stripped sandbox
  (item E6).
- MED #1: Legacy activity mirror is a host-owned regular-file
  fanout with identical quota/pruning/tombstoning/protection
  semantics — NOT a symlink/hardlink. Operator can also choose
  explicit downgrade via `PI_ENGINEERING_LEGACY_MIRROR=disabled`
  (item E12).
- MED #2: `pi_eng_protection_block_total` now uses bounded
  labels `{path_class, rule, surface}` instead of raw path. Raw
  redacted path goes to logs/exemplars only (E4).
- MED #3: `pi_eng_counter_wal_drops_total{reason}` added to the
  catalog and runbook; ANY non-zero is page-worthy (E4, E1).
- LOW: Capability-probe bundles get bounded retention (per-
  provider 100 bundles / 256 MB, 90-day TTL, GC on every new
  probe, cache-reuse on fingerprint match) plus new metrics
  `pi_eng_capability_bundle_disk_bytes` and
  `pi_eng_capability_bundle_gc_total{reason}` (item 0a, E4).

**Rejected:** (none — every finding was material and incorporated.)

### Round 10 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH #1: Rollback now takes an exclusive global drain lock
  at `<runsDir>/.rollback.lock` checked by every CLI/server
  spawn before starting a run. Held from readiness through
  install. CI race test attempts spawns during each step
  (item E6).
- HIGH #2: Legacy mirror writes to the EXACT 2.0.x filename
  `<runDir>/agent-activity.jsonl` (not a `.legacy-mirror.jsonl`
  suffix); CI test runs the actually-released 2.0.x CLI binary
  against a new-server run (item E12).
- MED #1: Bundled baseline capabilities now declared
  wildcard (`accountFingerprint:"*"`, `modelId:"*"`,
  `runtimeFlags:["*"]`, `baselineOnly:true`); usable only in
  `observe`/`warn` and as probe seeds; `enforce` requires a
  concrete per-account probe (first-spawn inline probe). CI
  tests account/model drift behavior (item 1).
- MED #2: Feature decisions are frozen per run via
  `<runDir>/feature-decisions.json`; deterministic from
  `hash(runId+provider+modelId+accountFingerprint)`; rollout/
  auto-disable changes apply only to new runs (item 24).
- MED #3: Bounded cohort registry (max 256 buckets, persistent
  tuple→id mapping, overflow tail-cohort with paging metric);
  offline rollup script joins back to full dimensions for
  canary-gate evaluation while exported labels remain bounded
  (item E15).
- MED #4: Minimal always-on rollout-telemetry writer at
  `<configDir>/telemetry/rollout.jsonl` bypasses both
  `PI_ENGINEERING_TELEMETRY=0` and `LEGACY_MODE`; daily
  rotation + 32 MB/day cap; CI test asserts auto-disable
  fires with telemetry feature disabled (item E16).
- LOW #1: `stuck_warning_false_positive_ratio` is now a
  derived metric from two explicit counters (warnings emitted,
  outcomes resolved as `true_stuck` / `false_positive` /
  `unknown`); minimum-N gate prevents "green by construction";
  operator-ack signal documented (item E17).
- LOW #2: `pi_eng_activity_disk_usage_bytes{surface}` and
  `_quota_bytes{surface}` now carry a bounded `surface ∈
  {canonical, legacy-mirror}` label; cardinality test
  budgeted accordingly (item E4).

**Rejected:** (none — every finding was material and incorporated.)

### Round 11 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH #1: Rollback now discovers and fences running
  pi-engineering server/TUI/controller processes (pidfile
  registry + OS scan; SIGTERM-then-SIGKILL with grace); after
  install, restarts under target version and verifies
  `--version` matches before releasing the drain lock
  (item E6 step 2b + step 8).
- HIGH #2: On gate breach, controller enumerates active runIds
  whose frozen vector includes the breached feature and either
  pauses each at the next step boundary (with
  `pauseReason="gate-breach-<feature>"`) OR hot-degrades the
  feature to its declared Phase-safe equivalent for the
  remaining steps. Each feature declares its breach behavior;
  CI test triggers mid-workflow breach (item 24).
- HIGH #3: Legacy-mirror bytes are now charged to the SAME
  global `_activity` quota — `pi_eng_activity_disk_usage_bytes`
  sums both surfaces. Pruner sees both surfaces in one
  accounting; full-disk CI test asserts mirror-only fill
  triggers new-run refusal + alert (item E12).
- MED #1: `LEGACY_MODE=2.0.x` documented exception for the
  minimal always-on rollout-telemetry writer (E16) — legacy
  parity CI suite explicitly excludes that file from the
  byte-for-byte comparison. Separate
  `PI_ENGINEERING_EMERGENCY_NO_NEW_WRITES=1` super-mode
  documented for true no-writes incident posture (item 24).
- MED #2: Cohort key uses a STABLE host/account identifier
  (`hash(provider+modelId+accountFingerprint+hostId)`,
  `hostId = sha256(machineId+installPath)`); per-run decision
  derived from that key, not from `runId`. Affected accounts
  reported via `pi engineering cohort-report --feature <name>`
  (item 24).
- MED #3: Cohort overflow is a HARD ramp blocker (`>0` pauses
  every feature ramp until the registry is expanded); while
  overflow exists, per-run exemplars persist to
  `<configDir>/telemetry/overflow-exemplars.jsonl` so the
  offline rollup can still recover full dimensions for canary
  gates (E15).
- MED #4: Added `pi_eng_rollout_telemetry_drops_total`,
  `pi_eng_cohort_overflow_total`,
  `pi_eng_cohort_overflow_exemplar_drops_total`, and
  `pi_eng_stuck_warning_resolved_total` to the canonical
  catalog with thresholds (E4).
- LOW: Every E1 threshold expression must declare its
  aggregation rule (`sum`, `sum by (label)`); build fails on
  omission; per-label-value tests assert canonical + legacy
  surfaces have separate alert paths (E1).

**Rejected:** (none — every finding was material and incorporated.)

### Round 13 (Codex — ops and SRE review, deeper)
**Accepted (incorporated):**
- HIGH #1: Failsafe rollback helper is versioned + promoted
  only after `--self-test` passes; prior generations retained
  (default 3) so a broken new helper does not destroy the only
  boot-independent rollback path. CI ships a deliberately-
  broken helper and asserts symlink stays on prior version
  (item E6).
- HIGH #2: Rollback reordered — `rollback-readiness` and
  finish/cancel/migrate decisions happen WITH healthy
  controllers still running so active runs can progress. Only
  AFTER active-run resolution does the process fence step
  send SIGTERM/SIGKILL. Separate broken-boot emergency path
  (`--mark-active-runs-abandoned`) for when the current
  extension can't start at all (item E6 step ordering).
- MED #1: All kill-switch env vars get a `KillSwitchPoller`
  (default 5 s) that re-reads `<configDir>/kill-switches.env`
  and applies runtime semantics: new spawns frozen; active
  Phase B drains; active Phase A pauses/degrades/completes
  per declared response. CI test asserts <10 s latency
  without process restart (item 24).
- MED #2: Cohort key now includes `piVersion + piBuildHash`,
  so a canaried account on an untested Pi runtime fingerprint
  does NOT inherit prior cohort exposure — fresh coverage +
  SLO gates required for the new runtime. Cohort-report
  surfaces both account and runtime-fingerprint breakdowns
  (item 24).
- MED #3: Headless metric export state moved out of
  `<runsDir>/_telemetry` to `<configDir>/telemetry/`, so a
  full/read-only `<runsDir>` cannot blind disk-pressure /
  degradation signals. Exporter write failures fan out to a
  reserved emergency spool at
  `/var/tmp/pi-eng-emergency.jsonl` AND raise an independent
  stderr line (item E5).
- MED #4: Rollout-telemetry drops are FAIL-CLOSED — any drop
  signal is mirrored to the counter WAL + emergency spool,
  automatically blocks every feature-gate ramp, and pages on
  -call until the counter returns to zero for
  `recoveryWindowSec`. CI fills the cap and asserts ramp-blocking
  (item E16).
- LOW: Quota-vs-filesystem distinction codified: LOGICAL
  `_activity` quota exhaustion degrades to essential-only +
  tombstones (never refuses new runs); REAL ENOSPC refuses
  new runs with `runsdir-full`. Chaos/skew tests split into
  two paths; runbook documents both (item E12).

**Rejected:** (none — every finding was material and incorporated.)

### Round 15 (Codex — ops and SRE review, final)
**Accepted (incorporated):**
- HIGH #1: E8 metric exporter fragments + aggregator lock +
  canonical `metrics.prom` moved out of `<runsDir>/_telemetry`
  to `<configDir>/telemetry/`. CI asserts ENOSPC/EROFS on
  runsDir still allows alert scrape (item E8).
- HIGH #2: Rollback drain lock moved to
  `<configDir>/.rollback.lock` with `/var/tmp` emergency
  fallback; spawn paths use the same `LockHelper`. CI
  offline test asserts coordination under runsDir
  ENOSPC/EROFS (item E6).
- HIGH #3: `feature-decisions.json` added to Layer-A
  `isProtectedPath` list; write-once with hash+inode audit at
  `<configDir>/feature-decisions-audit.jsonl`; tamper detected
  on next read (item 9).
- MED #1: Rep-canary now requires a minimum of 30 completed
  runs PER LEAF COHORT (provider × modelId × accountFingerprint
  × piVersion), not just 200 total across ≥24 combos.
  Documented pooling rule for rare leaves with
  `pi_eng_cohort_pooled_total{provider}` (item E3).
- MED #2: Capability bundle GC retention is now keyed on the
  FULL `runtimeFingerprint` tuple (matches E9) and PINS
  bundles for any actively-exposed rollout cohort against
  age-based eviction. Canary advancement fails if any
  exposed cohort lacks a warm concrete bundle, paged via
  `pi_eng_canary_cold_cohort_total` (item 0a).
- LOW: E17's minimum-N denominator (50 resolved warnings
  over the window) now also gates the E1 stuck-warning
  on-call alert, so a single warning cannot page (item E1).

**Rejected:** (none — every finding was material and incorporated.)

## Status

This is the final round of the 15-round claudex adversarial loop.
All 15 rounds of substantive Codex findings (HIGH/MED/LOW across
security, ops, SRE) were incorporated into the plan. The plan is
now considered ready for implementation as a phased rollout per
items 24, E1–E17, with the feature-flag, capability-matrix,
rollout-control telemetry, and rollback discipline as documented.
