# Changelog

`@sartoris/pi-engineering` — Pi coding-agent extension wiring a multi-agent engineering team into Pi sessions.

This log is organized by user-visible capability rather than by commit. Each section names what now works, with the implementing phase commits in parentheses. Every phase commit listed here was reviewed across four adversarial Codex rounds; CRITICAL/HIGH findings were closed in micro-commits before the next phase.

---

## Unreleased — multi-agent evolution

Forty-one phase commits between Phases 4.5 and 6.5 lifted the extension from a single-workflow runner into a full cross-team adversarial system. Capability summary:

### Cross-team consult workflow

`/consult <topic> [teams=eng,valid,invest] [--rounds N]`

The Orchestrator dispatches in parallel to selected Leads. Each Lead writes its team's position to `<run>/positions/<lead>.md`, reads peers' positions, writes adversarial pushback to `<run>/adversarial/<lead>.md`, then the Orchestrator synthesizes everything into `<run>/synthesis.md`.

- Single-round consult and three default teams (eng / valid / invest) (`feat(phase-4)` 43de07a)
- Per-run workflow registration so concurrent consults don't share state (`fix(phase-4.4)` afdfb88)
- Per-run consult metadata persisted atomically with the first state save (`fix(phase-6.4)` 2b3f4c8)
- Multi-round revision: `--rounds N` (1 ≤ N ≤ 5). Each round-N position step depends on every Lead's round-(N-1) adversarial; Leads explicitly revise positions in light of prior critiques. Synthesis reads every round's files (`feat(phase-6)` 94bf109).
- `maxIterations` + `maxWallSeconds` scale with round count so large consults don't budget-fail before synthesis (`fix(phase-6.1, 6.2)` 439c075, b148f94)
- Leads + Orchestrator have Write/Edit at the Pi tool boundary, scoped to `${RUN_DIR}` by force_block Layer-D policies (`feat(phase-6.5)` 4b0912d, `fix(phase-6.5.1)` a90ed31)
- PASS-without-artifact downgrades to FAIL so an agent claiming success without producing the expected file doesn't poison downstream steps (`fix(phase-6.3)` 9f4e91d)
- Step prompts read prior-round paths from `ctx.run.artifacts` (PASS-recorded only); missing leads are explicitly called out so adversarials degrade gracefully (`fix(phase-6.3, 6.4)` 9f4e91d, 2b3f4c8)

### TillDone team task coordination

`TaskUpdate` and `TaskList` tools track work per team.

- Optional `team` field on every Task (`feat(phase-5.5)` b808d34)
- Orchestrator system-reminder injection: "N tasks pending team assignment" + "M tasks still in flight" at every Orchestrator dispatch (`feat(phase-5.5)` b808d34)
- `taskId` and `runId` regex validation at every write boundary; safe ID guard centralized in RunState (`fix(phase-5.5.1, 5.5.2)` 389fd35, 9e4532f)
- `tasks.json` hard-blocked from worker Write/Edit/Bash via Layer A (only the TaskUpdate tool may modify it) (`fix(phase-5.5.2, 5.5.3, 5.5.4)` 9e4532f, 29cbf6a, 228f2c6)
- Per-runId mutex around the load-mutate-save sequence so concurrent DAG fan-out doesn't last-writer-wins task state (`fix(phase-5.6.4)` 818da6b)

### Pi TUI TillDone footer

A live status line that surfaces task progress alongside agent activity in the Pi status bar.

- `ui.setStatus("tilldone", ...)` channel showing per-team done/total counts (`feat(phase-5.6)` d358d6d)
- Multi-line `/run-status` variant with status markers (✓ completed, ● in_progress, ✗ blocked, ○ pending) (`feat(phase-5.6)` d358d6d)
- Stable team column order, 40-char goal clip, 200-char line cap (`fix(phase-5.6.1)` 0968964)
- Sanitization of ASCII control bytes AND Unicode visual controls (U+200B, U+2028/9, U+200E/F, U+202A-E, U+2066-9, U+FEFF) (`fix(phase-5.6.1, 5.6.2, 5.6.3)` 0968964, f934fe4, d351545)
- Run-scoped UI callbacks via `uiCallbacksOwner` so concurrent shortcut-triggered runs don't clear each other's status (`fix(phase-5.6.3)` d351545)
- Mid-step refresh on every TaskUpdate audit line via the host's subprocess audit hook (`fix(phase-5.6.2)` f934fe4)
- Per-runId 250 ms debounce with in-flight tracking + dirty-flag follow-up + per-call generation token; burst-write coalescing without losing visibility into the latest state (`feat(phase-5.7)` 2916a87, `fix(phase-5.7.1–4)` aae9d1c, 9579663, 50c152b, 43ddca2)
- `abortRun` and `/run-resume` properly drain the footer through the same cleanup path (`fix(phase-5.7.4)` 43ddca2, `fix(phase-6.4)` 2b3f4c8)

### Verifier loop + Learner agent

A read-only adversarial verifier runs after every worker `VerdictEmit` in workflows that opt in via `verify: true`. The Learner turns PARTIAL verdicts into new verifier scripts under Judge approval.

- Verifier loop with PARTIAL verdict, deterministic script invocation, host-writes-report (verifier has no Write tool) (`feat(phase-3)` 7c23827, hardened across rounds 3.1–3.4)
- Learner with 3 safety gates: domain lock to `.staging/`, Judge HMAC approval, fixture-and-validation contract (`feat(phase-3.5)` 7005876, hardened in 3.5.1–3.5.4)
- Verifier correction events appear in `conversation.jsonl` as `kind=correction`, awaited so the entry lands before the worker reply (`fix(phase-4.5.2)` dc7f3bb)

### Secrets vault

API keys never appear in prompts, events, or conversation history. The watcher catches leaks and retroactively scrubs them.

- AES-256-GCM vault with scrypt KDF, OS keyring with passphrase fallback (Phase 1)
- `/secret-set`, `/secret-list`, `/secret-show`, `/secret-rm`, `/secret-scrub` commands
- Per-resolve audit events emitted to subprocess audit file with category=safety; controller drains and stores
- Auto-vaulting watcher: a key accidentally pasted into a prompt is moved into the vault and stripped from history

### Domain locking (SafetyGuard Layer D)

Per-agent path policies enforce who can write where.

- Three-layer config merge: built-in defaults → user yaml → project yaml.local
- `force_block` policies (verifier, learner, all leads, orchestrator) enforce hard-block regardless of global mode (Phase 3.5 + Phase 6.5.1 a90ed31)
- Global Layer-A blocks for the expertise dir and `tasks.json` apply even to agents without a domain policy (`fix(phase-5.4, 5.5.4)` 9a0a0e1, 228f2c6)
- Symlink/TOCTOU defenses on the rollback path: atomic quarantine rename, lstat-then-realpath validation, canonical-path operations (`fix(phase-4.2, 4.3, 4.4)` cf3fcd7, 163138a, afdfb88)
- runsDir-aware path matching so non-standard layouts still protect `tasks.json` (`fix(phase-5.5.3, 5.5.4)` 29cbf6a, 228f2c6)

### Per-agent expertise (mental models)

Compounding knowledge curated by Memory Core from `VerdictEmit` wisdom fields. Agents never write expertise files directly.

- `~/.pi/engineering-team/expertise/<agent>.md` (user-global) + `<cwd>/.pi/engineering-team/expertise/<agent>.md` (project-local) (`feat(phase-5)` 8f38334)
- `_readonly/*.md` files for user-authored domain knowledge with frontmatter `agents: [...]` gating
- VerdictEmit schema declares `learnings`, `decisions`, `issues_found`, `gotchas` (Phase 5.1)
- Promotion: an entry seen across N≥3 distinct projects moves from project-local to user-global; the `[promote]` tag triggers immediate promotion
- Boot-time injection into agent system prompt under `===BEGIN-EXPERTISE-DATA-BLOCK===` sentinel with HTML-entity-escaped content + sentinel-string disarming (defense against fence-closing prompt injection from stored wisdom) (`fix(phase-5.2, 5.3, 5.4)` bac55e0, 2d50cf0, 9a0a0e1)
- 500-char-per-entry + 50-entries-per-batch + 8000-char total render caps (`fix(phase-5.2, 5.3, 5.4)`)
- `destroyed` flag rejects late-arriving wisdom after shutdown so the buffer can't grow unbounded (`fix(phase-5.4)` 9a0a0e1)

### Run lifecycle: cancel, rollback, resume

- `/run-cancel <runId>` — graceful, sets `phase: cancelling`, halts at next step boundary, preserves all state (`feat(phase-4)` 43de07a)
- `/run-rollback <runId>` — nuclear, wipes the run dir except `cancelled.log`; quarantine-rename + lstat per-entry defense
- `/run-abort` — alias for `/run-cancel` with the same mutex discipline (`fix(phase-4.4)` afdfb88)
- `/run-resume <runId>` — reconstructs ephemeral consult workflows from persisted `consultTeams` + `rounds.max` on resume; binds UI callbacks for footer refresh (`fix(phase-6.2)` b148f94)
- Interrupted runs (Pi process killed mid-execution) are downgraded `running → paused` on next session start instead of aborted, so they're resumable (`fix(phase-6.4)` 2b3f4c8)
- DAG resume skips already-PASSed steps and doesn't tick the iteration budget on fully-skipped levels (`fix(phase-6.3, 6.4)` 9f4e91d, 2b3f4c8)

### DAG-based parallel execution

- `dependsOn?: string[]` + `parallel?: boolean` on `Step` — workflows declare a DAG; same-dependsOn-set steps form a level and run via `Promise.allSettled` (`feat(phase-4)` 43de07a)
- Cycle detection at workflow registration
- Per-runId mutex (`withRunStateLock`) serializes load-modify-save across `applyStepResult` and `/run-cancel`; in-flight terminal saves honor a concurrent cancel (`fix(phase-4.2, 4.3, 4.4)` cf3fcd7, 163138a, afdfb88)
- Iteration counter increments per level so `maxIterations` actually fires (`fix(phase-4.2)` cf3fcd7)
- Budget gate runs at every level boundary in both linear and DAG paths (`fix(phase-4.1, 4.2)` 76ffdf3, cf3fcd7)

### Conversation projection (`<run>/conversation.jsonl`)

Spec §9.1: a normalized, agent-readable dialogue stream filtered from `events.jsonl`.

- `{ts, from, to, kind, text, ref?}` schema with `kind ∈ {request, dispatch, position, adversarial, synthesis, correction, verdict, note}` (`feat(phase-4.5)` 83af2bb)
- Host-trusted in-memory marker (non-forgeable; cannot be set from subprocess payload) prevents impersonation of `user`/`system`/`verifier`/`host` (`fix(phase-4.5.2, 4.5.3)` dc7f3bb, dd664e2)
- Worker-controlled `payload.step` is ignored; verdict kind derives from host-set `evt.step` only (`fix(phase-4.5.3)` dd664e2)
- Subprocess audit category whitelist (tool_call, tool_result, message, error, budget); verdict and lifecycle are host-only (`fix(phase-4.5.4)` 7445d25)

### Rate limit + multi-provider routing

- Sliding-window per-provider quotas (RPM, TPM, concurrent in-flight) (Phase 1.5)
- Account-scoped quotas (`{provider, account}`)
- `model-routing.json` declares preference order across providers
- Per-deliver event token isolates subprocess audit drains so parallel deliveries don't steal each other's events

---

## Conventions

- Each phase ships as a `feat(phase-N)` baseline commit, then `fix(phase-N.K)` commits for round-K Codex review findings. The `.K` suffix increments per round.
- "Closed" issues from a Codex review are listed by severity tag (CRITICAL/HIGH/MEDIUM/LOW) and a short title in the commit message. "Deferred" items are explicit (with a rationale) — they're not silent.
- 836 tests passing across 75 files at the time of this snapshot. The build chain is `pnpm typecheck && pnpm test && pnpm build`.

---

## Tracked Deferrals (low severity, doc-only or out-of-scope)

These are noted in commit messages and not load-bearing. No spec deliverable depends on them:

- counts.json cross-process race for expertise promotion (could ship `proper-lockfile`; promotion is best-effort)
- Linux bind-mount aliasing in `isProtectedPath` (out-of-scope for v1; documented limitation)
- HTML-entity double-encoding in stored wisdom (cosmetic; agent's mental-decode instruction handles it)
- Multi-round revision-with-verifier loop (Phase 6 ships rounds; verifier integration into consult is an explicit non-goal per spec §5.1)
