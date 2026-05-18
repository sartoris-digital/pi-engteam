# pi-engineering

A [Pi coding agent](https://pi.dev) extension that wires a hardened multi-agent engineering team into your Pi session. Workflows decompose goals across specialist agents (planner, implementer, reviewer, judge, …) on a typed message bus, with a four-layer safety guard, cryptographic approval tokens, and a built-in observability dashboard.

Runs on the **Pi Agent SDK** — credentials resolve through Pi's `ModelRegistry`, so any provider you've configured (Claude Code subscription, GitHub Copilot, OpenAI, ZenMux, …) works transparently with no separate API key.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installation](#installation)
3. [Your First Workflow](#your-first-workflow)
4. [Command Reference](#command-reference)
5. [Workflow Reference](#workflow-reference)
6. [Agent Roster](#agent-roster)
7. [Custom Tools](#custom-tools)
8. [Safety System](#safety-system)
9. [Secrets Vault](#secrets-vault)
10. [Observability](#observability)
11. [Memory Core](#memory-core)
12. [Configuration](#configuration)
13. [Architecture](#architecture)
14. [Development](#development)
15. [End-to-End Walkthrough](#end-to-end-walkthrough)

---

## Quick Start

```bash
# Install
pi install https://github.com/sartoris-digital/pi-engineering

# Restart Pi, then in your Pi session:
/eng-plan "Add email/password login with JWT tokens"

# Watch the run in another terminal:
/observe   # opens http://127.0.0.1:4747
```

That's it. The planner decomposes your goal, the implementer writes the code, the reviewer audits it, and the judge gates anything destructive. State, events, and verdicts are persisted under `~/.pi/engineering-team/runs/<runId>/`.

---

## Installation

### Prerequisites

- [Pi coding agent](https://pi.dev) installed
- Node.js ≥ 20

### Install via Pi (recommended)

```bash
pi install https://github.com/sartoris-digital/pi-engineering
```

Pi clones the repo, runs `npm install`, and `scripts/postinstall.mjs` automatically:

| Action | Result |
|--------|--------|
| Build server bundle | `tsup server/index.ts → dist/server.cjs` |
| Install server | `dist/server.cjs` → `~/.pi/engineering-team/server.cjs` |
| Install native addon | `better_sqlite3.node` → `~/.pi/engineering-team/better_sqlite3.node` |
| Install agent definitions | `agents/*.md` → `~/.pi/agent/agents/engineering-*.md` |
| Lock sensitive dirs | `~/.pi/engineering-team` and `runs/` chmod'd to `0o700` |

Pi loads the extension directly from `src/index.ts` via its built-in TypeScript transpiler — no separate build step required. **Restart Pi** and the team is registered automatically. Run `/workflows` to list the available shortcuts.

### Install from source

```bash
git clone https://github.com/sartoris-digital/pi-engineering
cd pi-engineering
pnpm install   # also runs postinstall
```

To use the pre-built ESM bundle instead of jiti/source loading:

```bash
pnpm engineering:install   # pnpm build && bash scripts/install.sh
```

### Uninstall

```bash
bash scripts/uninstall.sh
```

### Sanity check

```
/engineering-doctor
```

Verifies the extension is loaded, the runs dir exists, agent files are installed, and the safety config parses.

---

## Your First Workflow

Most workflows follow the same shape: pick a shortcut, hand it a goal, watch progress.

### Pattern 1: implement a feature

```
/eng-plan "Add a rate-limiter to the public API endpoints"
```

Runs `plan → build → review`. Planner produces `plan.md`, implementer writes the code, reviewer audits it. On review FAIL the run ends; use `/plan-fix` if you want an automatic retry loop.

### Pattern 2: discover + spec + build (human-gated)

```
/spec "Add dark mode toggle to settings"
```

Pauses **three times** to collect human input:

1. **Discoverer** writes `questions.md` → a TUI wizard opens, you answer, submit with Ctrl+Enter.
2. **Architect** writes `spec.md` → review it in your editor → type `approve` in Pi to continue.
3. **Planner** writes `plan.md` → review it → type `approve` to start the build.
4. **Implementer** + **Reviewer** complete the run.

State is per-project at `<cwd>/.pi/engineering-team/active-run.json`, so multiple `/spec` runs in different projects never collide.

### Pattern 3: investigate a bug or incident

```
/triage "Users on iOS 17 cannot complete checkout — cart empties on payment"
/debug "Memory usage grows 50 MB/hour in the event processor worker"
/investigate "Production API returning 503s since 14:00 UTC"
```

Triage classifies severity and routes. Debug runs a 7-stage competing-hypothesis protocol. Investigate is open-ended.

### Pattern 4: from a tracker ticket

```
/issue 1234                                    # GitHub issue (auto-detected)
/issue PROJ-42                                 # Jira
/issue https://github.com/org/repo/issues/42   # explicit URL
```

Writes `issue-brief.md` with ticket metadata, problem statement, acceptance criteria, and a *suggested downstream workflow + goal* you can paste straight into the next shortcut.

### Following progress

Every shortcut prints three ways to follow along once the run starts:

```
▶ plan-build-review started (run a1b2c3d4)
Goal: Add a rate-limiter to the public API endpoints

Watch progress:
  /run-status a1b2c3d4-...
  /observe  (dashboard at http://127.0.0.1:4747)
  tail -f ~/.pi/engineering-team/runs/<runId>/events.jsonl
```

A live **TillDone footer** also appears in Pi's TUI showing current step + task progress.

---

## Command Reference

The extension surfaces 32 slash commands. There is no team-start step — agents are spawned per workflow step on demand.

### Workflow shortcuts

| Command | Workflow | Description |
|---------|----------|-------------|
| `/eng-plan <goal>` | `plan-build-review` | Plan → build → review. **Use this in preference to `/plan`** (`/plan` may be shadowed by other extensions). |
| `/plan <goal>` | `plan-build-review` | Same as `/eng-plan` but vulnerable to slash-name collisions (Pi suffixes duplicate registrations). |
| `/plan-fix <goal>` | `plan-build-review-fix` | Plan → build → review → fix → review (self-healing loop on FAIL). |
| `/spec <goal>` | `spec-plan-build-review` | Human-gated discovery wizard → spec → plan → build → review. |
| `/issue <id\|url>` | `issue-analyze` | Fetch a ticket (GitHub / ADO / Jira) and write `issue-brief.md` with a suggested next workflow. |
| `/fix <issue>` | `fix-loop` | Analyse a failing test or bug, fix it, iterate until tests pass. |
| `/debug <problem>` | `debug` | Gather context → root-cause analysis → propose fix → judge-gate. |
| `/investigate <incident>` | `investigate` | Open-ended investigation with judge sign-off. |
| `/triage <bug>` | `triage` | Classify severity, assign owner, judge-gate. |
| `/verify <module>` | `verify` | Audit coverage, write missing tests, validate. |
| `/migrate <goal>` | `migration` | Plan → security-review → implement → test a DB or infra migration. |
| `/refactor <goal>` | `refactor-campaign` | Map → design → implement → verify → review for large refactors. |
| `/docs <module>` | `doc-backfill` | Audit → plan → write → review documentation. |
| `/consult <topic>` | (built per-call) | Cross-team adversarial review. Flags: `[teams=eng,valid,invest] [--rounds N]` (max 5). |
| `/workflows` | — | Print the full list of workflows with examples. |

### Run management

| Command | Usage | Description |
|---------|-------|-------------|
| `/run-start` | `/run-start <workflow> "<goal>" [maxIter] [maxCost]` | Start a run by workflow ID. |
| `/run-status` | `/run-status <runId>` | Status, step, iteration, budget, TillDone progress. |
| `/run-resume` | `/run-resume <runId>` | Resume a paused or interrupted run. |
| `/run-cancel` | `/run-cancel <runId>` | Graceful cancel at next step boundary; state preserved. |
| `/run-abort` | `/run-abort <runId>` | Deprecated alias for `/run-cancel`. |
| `/run-rollback` | `/run-rollback <runId>` | Wipe a run's directory (use when `/run-cancel` didn't take). |
| `/run-plan-mode` | `/run-plan-mode on\|off` | Toggle plan-mode (read-only) for the active run. |

### Utilities

| Command | Description |
|---------|-------------|
| `/observe` | Start the observability dashboard on port 4747. |
| `/observe stop` | Stop the dashboard. |
| `/engineering-doctor` | Check installation health. |
| `/learn [runId]` | Process verifier gap logs into new verifier scripts (Judge-gated promotion). |

### Secrets vault

See [Secrets Vault](#secrets-vault) for the full reference.

| Command | Usage |
|---------|-------|
| `/secret-set` | `/secret-set <NAME> [--note "..."] (--value <v> \| --from-file <p>)` |
| `/secret-list` | List secret names + metadata (never values) |
| `/secret-rm` | `/secret-rm <NAME> --yes` |
| `/secret-rotate` | `/secret-rotate <NAME> (--value <v> \| --from-file <p>)` |
| `/secret-export` | `/secret-export "<path>" (--passphrase <pp> \| --passphrase-from-file <p>) --yes` |
| `/secret-import` | `/secret-import <path> (--passphrase <pp> \| --passphrase-from-file <p>) [--on-conflict overwrite\|skip\|abort]` |
| `/secret-scrub` | `/secret-scrub <NAME> (--value <leaked> \| --from-file <p>)` — vault + scrub from logs |

---

## Workflow Reference

Workflows are state machines. Each step dispatches a goal to a designated agent, waits for a `VerdictEmit` tool call (`PASS` / `FAIL` / `NEEDS_MORE`), and routes to the next step based on the verdict and any handoff hint.

| ID | Steps | Notes |
|----|-------|-------|
| `issue-analyze` | analyze | Writes `issue-brief.md` with a suggested next workflow. |
| `spec-plan-build-review` | discover → design → plan → build → review | Three human-gated pause points (see `/spec`). |
| `plan-build-review` | plan → build → review | The default feature-implementation flow. |
| `plan-build-review-fix` | plan → build → review → fix → review | Adds an automatic fix loop on review FAIL. |
| `investigate` | gather-context → analyze → report | Judge-gated, ends with a write-up. |
| `triage` | classify → route → judge-gate | Severity + owner assignment. |
| `verify` | gather-context → check → judge-gate | Coverage and correctness audit. |
| `debug` | gather-context → analyze → propose-fix → judge-gate | 7-stage root-cause protocol. |
| `fix-loop` | analyze → fix → verify | Iterates until verification passes. |
| `migration` | plan → implement → verify → judge-gate | Security-reviewed DB/infra migration. |
| `refactor-campaign` | analyze → plan → implement → review | Large-scale refactor. |
| `doc-backfill` | analyze → draft → review | Generate missing docs. |

### How a step works

1. The engine builds a `StepContext` — goal, runId, runsDir, artifacts from earlier steps.
2. `TeamRuntime.deliver(agent, message, { runId, hostStep })` spawns a fresh `pi -p` subprocess with the assembled system prompt and a minimal env (allowlist).
3. The subprocess registers safety hooks, runs the agent, calls `VerdictEmit`, and exits. The host has a 10-min hard timeout (SIGTERM → SIGKILL escalation, process-group cleanup).
4. The verdict file is size-capped at 256 KB, schema-validated, and the artifact paths are realpath-resolved and containment-checked under `cwd` or `runDir`.
5. The verdict routes to the next step. Artifacts are merged into run state for downstream steps.

### Budget

```
/run-start plan-build-review "add search to posts API" 20 5.00
#                                                       ^   ^
#                                              maxIter maxCostUsd
```

Workflow defaults are merged with command overrides. Exhaustion halts the run with `status: "failed"`.

### `/consult` — adversarial cross-team review

```
/consult "Should we add SSR to the marketing site?" teams=eng,valid,invest --rounds 2
```

Each named team's Lead writes a position in parallel under `<run>/positions/<lead>.md`. Optional revision rounds let leads sharpen or concede in light of peers' adversarial critiques (`<run>/adversarial/<lead>RN.md`). The Orchestrator writes a final `synthesis.md`. Rounds are capped at 5; positions must be written to the exact pre-computed artifact path or the step downgrades to FAIL.

---

## Agent Roster

23 agents in a three-tier hierarchy:

```
orchestrator (top-level router)
├── planning-lead       ↳ planner · architect · discoverer · codebase-cartographer · knowledge-retriever
├── engineering-lead    ↳ implementer · root-cause-debugger · performance-analyst
├── validation-lead     ↳ reviewer · tester · security-auditor
└── investigation-lead  ↳ incident-investigator · bug-triage · observability-archivist · issue-analyst

cross-functional (no team)
├── judge       — sole approval-token signer
├── verifier    — read-only claim atomiser; runs verifier-scripts via `uv run --script`
└── learner     — promotes new verifier-scripts behind Judge approval (gap-driven)
```

### Orchestrator + Leads

| Agent | Model | Role |
|-------|-------|------|
| `orchestrator` | claude-opus-4.6 | Top-level router. Classifies requests, decomposes into team-shaped tasks, dispatches to Leads in parallel, synthesises Lead verdicts back. Never addresses workers directly. |
| `planning-lead` | claude-opus-4.6 | Coordinates planning workers; produces one team position from their VerdictEmits. |
| `engineering-lead` | claude-opus-4.6 | Coordinates engineering workers; escalates scope expansion. |
| `validation-lead` | claude-opus-4.6 | Coordinates validation workers; security-auditor Critical/High FAIL is blocking. |
| `investigation-lead` | claude-opus-4.6 | Coordinates investigation workers; incident syntheses include a Timeline section. |

Leads delegate; they do not execute. Their `Write`/`Edit` access is restricted by Layer D to `<run>/positions/`, `<run>/adversarial/`, and (orchestrator only) `<run>/synthesis.md`. **All Lead and Orchestrator policies carry `force_block: true`** — out-of-domain writes hard-error instead of warning.

### Specialist workers

| Agent | Model | Team | Role |
|-------|-------|------|------|
| `planner` | claude-opus-4.6 | planning | Decomposes goals; writes `plan.md` after a 6-lens requirements-gap analysis. |
| `architect` | claude-opus-4.6 | planning | ADR-style `spec.md` (Problem · Approach · Acceptance · Interfaces · Out of Scope · Open Questions). |
| `discoverer` | claude-haiku-4.5 | planning | 3–5 discovery questions for `/spec`. |
| `codebase-cartographer` | claude-sonnet-4.6 | planning | Maps modules, dependencies, hotspots. |
| `knowledge-retriever` | claude-sonnet-4.6 | planning | `context-pack.md` from code + docs + tickets. |
| `implementer` | claude-sonnet-4.6 | engineering | Writes code with TDD; calls `RequestApproval` for any destructive op. |
| `root-cause-debugger` | claude-opus-4.6 | engineering | 7-stage hypothesis protocol → `fix-plan.md`. |
| `performance-analyst` | claude-sonnet-4.6 | engineering | Latency / N+1 / memory / concurrency review. |
| `reviewer` | claude-opus-4.6 | validation | Requires 3 evidence gates: fresh test output, LSP diagnostics, acceptance coverage. |
| `tester` | claude-sonnet-4.6 | validation | TDD: failing test → fix → confirm clean `pnpm test`. |
| `security-auditor` | claude-opus-4.6 | validation | Static analysis + secrets + auth + deps. Read-only; Critical/High forces FAIL. |
| `incident-investigator` | claude-opus-4.6 | investigation | 7-stage protocol with a Timeline section. |
| `bug-triage` | claude-haiku-4.5 | investigation | Classifies P0–P3, dedupes, assigns owner. |
| `observability-archivist` | claude-sonnet-4.6 | investigation | Builds trace timelines, surfaces anomalies. |
| `issue-analyst` | claude-haiku-4.5 | investigation | Fetches tickets from GitHub / ADO / Jira CLIs. |

### Cross-functional

| Agent | Model | Role |
|-------|-------|------|
| `judge` | claude-opus-4.6 | Final authority. The only agent that may call `GrantApproval`. Before PASS: runs `git diff`, confirms tests, verifies all reviewer issues are addressed. |
| `verifier` | claude-sonnet-4.6 | Read-only claim atomiser. Bash is restricted to `uv run --script` of allowlisted verifier scripts. |
| `learner` | claude-opus-4.6 | Privileged on-demand agent that converts verifier gap logs into staged verifier-script upgrades. Three gates: domain lock, **real GrantApproval token** (not just judge PASS), fixture validation. |

Per-agent tool allowlists in `AGENT_DEFS` are enforced by Layer D at the `tool_call` boundary, not just as prompt metadata.

---

## Custom Tools

All agents receive these tools in addition to Pi's built-ins.

### `SendMessage`

| Parameter | Type | Description |
|-----------|------|-------------|
| `to` | string | Recipient agent or `'*'` for broadcast |
| `summary` | string | One-line summary for observability |
| `message` | string | Full body |
| `requestId` | string? | For response pairing |

### `VerdictEmit`

Signal step completion. **Required at the end of every step turn.** Payload is bounded: max 64 items per array, max 4000 chars per string, max 128 chars on step name. Unknown keys are dropped.

| Parameter | Type | Description |
|-----------|------|-------------|
| `step` | string | e.g. `'build'` |
| `verdict` | `PASS \| FAIL \| NEEDS_MORE \| PARTIAL` | Outcome |
| `issues` | string[]? | Required when FAIL |
| `artifacts` | string[]? | File paths produced |
| `handoffHint` | string? | `'security'`, `'perf'`, `'re-plan'`, etc. |
| `learnings` | string[]? | Accumulated into Memory Core |
| `decisions` | string[]? | Accumulated into Memory Core |
| `issues_found` | string[]? | Accumulated into Memory Core |
| `gotchas` | string[]? | Accumulated into Memory Core |

### `TaskList` / `TaskUpdate`

Per-run shared task ledger at `<run>/tasks.json`. Writes are serialized through a cross-process file lock + in-process mutex + atomic tmp+rename. Caller identity is enforced: only the orchestrator may reassign `team`; non-orchestrator agents can only mutate tasks they own. `tasks.json` writes by anyone other than `TaskUpdate` are hard-blocked by Layer A.

### `RequestApproval`

Request Judge approval before any destructive op. Write the request and **wait** until `GrantApproval` lands.

| Parameter | Type | Description |
|-----------|------|-------------|
| `op` | string | One of `git-push`, `npm-install-new`, `migration`, `bash`, `write`, `edit`, `verifier-script-update` |
| `command` | string | Exact command or file path |
| `justification` | string | Why this is necessary |

### `GrantApproval` (Judge only)

| Parameter | Type | Description |
|-----------|------|-------------|
| `requestId` | UUID | The ID from `RequestApproval` |
| `ttlSeconds` | number? | Default + cap from `tokenTtlSeconds` |
| `scope` | `once \| run-lifetime` | `once` default; `run-lifetime` requires `allowRunLifetimeScope` |
| `expectedOp` | string? | Defense-in-depth: echo back the op you're approving |
| `expectedCommand` | string? | Defense-in-depth: echo back the command |

Tokens are HMAC-SHA256 signed over `runId:tokenId:op:argsHash:expiresAt`. Atomic rename moves the consumed token out of `pending/` before signing (TOCTOU close). Files are written with `0o600`. Verification uses `timingSafeEqual`.

### `UseSecret`

Run a shell command with a vaulted secret injected as `$SECRET` in the child env. The secret value never reaches agent context.

- 5-minute default timeout (configurable per call)
- spawned with `detached: true` in its own process group; timeout escalates SIGTERM → SIGKILL across the group
- stdout/stderr capped at 1 MB per stream; overflow kills the child
- commands invoking the Pi CLI (`pi -p`) or setting `PI_ENGINEERING_*` env vars are refused (no nested-pi privilege escalation)

---

## Safety System

Four layers, evaluated in order on every tool call.

### Layer A — Hard blockers (always on)

Blocked regardless of approval tokens:

- `rm -rf` against root / home / `.pi` paths
- `sudo`
- `git push --force` to `main` / `master`
- Writes to `.env`, `.env.*`, launchd / systemd configs, device files
- Writes / reads / Bash anywhere under `<runsDir>/_agent_tmp/` (host-only scratch)
- Writes to `<run>/tasks.json` by anyone except `TaskUpdate`
- Writes anywhere under `<expertise>` by anyone except Memory Core
- Bash command size > 16 KB (forces approval gate)
- Compound shell operators inside verifier `bash_policy: script-only` runs (`;`, `&&`, `|`, `$(`, backticks, redirects, heredocs)

### Layer B — Plan-mode gate

When the active run's state has `planMode: true`, only read-only tools and safe Bash verbs (`cat`, `ls`, `git status/diff/log`) are allowed. Subprocess mode also enforces Layer B by reading `PI_ENGINEERING_RUN_ID` first, falling back to `active-run.txt`.

### Layer C — Default-deny classification

`Bash`, `Write`, `Edit` require a valid approval token unless classified safe. Safe verbs (`cat`, `ls`, `find`, `grep`, `git status/diff/log/blame`, test runners, linters, type checkers) pass through.

### Layer D — Per-agent domain lock

Each agent declares an explicit `tools: [...]` allowlist plus a domain policy (read paths, upsert paths, delete paths, optional `bash_policy: script-only`). Layer D enforces this at the subprocess `tool_call` boundary.

All Lead and Orchestrator policies are `force_block: true`. Domain policies live in `teams.yaml` / `teams.local.yaml`. **If the YAML fails to parse, mode is forced to `block`** — typos cannot silently weaken enforcement.

### Approval flow

```
Implementer                    Judge
    │                            │
    ├── RequestApproval ─────────►   (writes <run>/approvals/pending/<id>.json, 0o600)
    │                            │
    │                            ├── Reviews request
    │                            ├── GrantApproval ──────────►
    │                            │   (atomic rename + HMAC sign + 0o600 write)
    │◄────────────────────────────────── tokenId, expiresAt ─┤
    │                                                         │
    ├── Bash / Write (with tokenId) ──► SafetyGuard verifies
    │                                   token.runId === envRunId
    │                                   timingSafeEqual(HMAC)
    │                                   Date.parse(expiresAt) > now
    │                                   atomic-consume via rename
    └── Operation executes if valid
```

### Other defenses

- **Worker stdio**: subprocess spawned with `["ignore", "pipe", "pipe"]` — no inherited stdin, stderr captured + ANSI-stripped + size-capped before forwarding.
- **Worker env**: only an allowlist of vars is forwarded (`PATH`, `HOME`, `USER`, `LANG`, LLM provider keys, `GITHUB_TOKEN`, `PI_*`). Ambient credentials never leak to children.
- **Worker output to prompts**: agent-supplied `handoffHint` and `issues[]` are wrapped in `<<<UNTRUSTED_*_BEGIN>>>` / `<<<UNTRUSTED_*_END>>>` fences with a per-call CSPRNG nonce, control chars stripped, payload byte-capped.
- **Subprocess events**: per-deliver `events-subprocess-<token>.jsonl` is size-capped (8 MB) and line-capped (50 000), then schema-validated per line before forwarding to the observer.
- **Active-run pointer**: validated against `runId` shape, `runsDir` absolute-path, allowed `phase`/`stepName`; malformed file is unlinked.

### Test coverage

836+ tests cover safety classification, approval HMAC + binding, domain lock, plan-mode, atomic writes, file-locking, and the workflow state machine.

---

## Secrets Vault

The vault is an OS-keyring-backed store (`@napi-rs/keyring`, scrypt KDF + AES-256-GCM) used by `UseSecret`. Agents never see raw values — they reference secrets by name.

**All vault commands take input via non-interactive flags.** Pi's TUI consumes stdin while a handler runs, so a readline prompt would deadlock. For values that should not enter chat history, write to a file with `umask 077` and use `--from-file`.

```bash
# Example: store a token without putting it in chat history
umask 077 && printf '%s' "$YOUR_REAL_TOKEN" > /tmp/secret.txt
# Inside Pi:
/secret-set MY_API_KEY --note "Production API" --from-file /tmp/secret.txt
shred -u /tmp/secret.txt
```

A proactive **scrubber** also runs on every captured event. The pattern set (`src/secrets/patterns.ts` — Anthropic `sk-ant-*`, OpenAI `sk-proj-*`/`sk-*`, GitHub `github_pat_*`/`ghp_*`/`gho_*`, …) is regex-screened for catastrophic backtracking before load and is enforced fail-closed: if pattern loading fails the subprocess audit writes only `{ts, note: "redacted-no-patterns", keys}` shape — never raw payload bytes.

If the vault itself fails to open, a **fail-closed input handler** blocks user messages containing likely-secret patterns until the vault is repaired.

---

## Observability

```
/observe                # start dashboard
/observe stop
```

Server runs on `PI_ENGINEERING_SERVER_PORT` (default 4747). Dashboard at `http://127.0.0.1:4747`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | `{"ok": true}` |
| `GET` | `/` | HTML dashboard |
| `GET` | `/runs?limit=&offset=` | List runs (limit 1-200) |
| `GET` | `/runs/:id` | Single run state |
| `GET` | `/runs/:id/events?category=&since=&limit=&offset=` | Events for a run (limit 1-1000) |
| `POST` | `/events` | Ingest NDJSON event batch |
| `GET` | `/stats` | Run counts + total events |

### Event categories

`lifecycle`, `tool_call`, `tool_result`, `message`, `verdict`, `budget`, `safety`, `approval`, `error`.

Events are appended to `<run>/events.jsonl` in real time. The server `EventWatcher` tails the file (inode-aware so rotation doesn't lose tails) and ingests into SQLite for cross-run queries. The writer rotates at 50 MB and retains up to 10 rotated files per run; per-run queue depth is capped at 1000 events with overflow drops surfaced via stderr.

---

## Memory Core

Memory Core summarises each Pi session into a daily markdown log so the team's decisions and completed work accumulate over time.

### How it works

At session end and before each compaction, Memory Core fires a two-stage flush:

1. **Narrative generation** — `MemoryCore.doFlush()` calls `completeSimple` from `@mariozechner/pi-ai` using credentials resolved via `pi.modelRegistry`. The summary uses whatever provider you've configured in Pi.
2. **Snapshot + flush script** — The narrative is written to a JSON snapshot, then `flush.mjs` is spawned detached as a pure-IO script. It appends to today's daily log (`~/.pi/engineering-team/second-brain/logs/YYYY-MM-DD.md`) and optionally syncs to an Obsidian vault.

### Daily log format

```markdown
## Session <id> — HH:MMZ

### Runs
| Run ID | Workflow | Goal | Verdict |
|--------|----------|------|---------|
| `abc123` | plan-build-review | Add rate limiting | PASS |

### Changed Files
- src/middleware/rateLimit.ts

### Wisdom
**Learnings**
- express-rate-limit requires trust proxy to be set when behind a load balancer
**Decisions**
- Chose sliding window over fixed window to avoid burst boundaries
**Gotchas**
- Rate limit headers differ between v6 and v7

### Summary
<LLM-generated paragraph>

---
```

Wisdom appears only when at least one run in the session emitted `learnings` / `decisions` / `issues_found` / `gotchas`. The run cache is LRU-capped at 500 entries.

### Memory config — `~/.pi/engineering-team/memory.json`

```json
{
  "flushModel": "claude-haiku-4-5-20251001",
  "maxConversationTurns": 20,
  "obsidianDailyNotesSubdir": "Daily",
  "obsidianVaultPath": "~/Documents/MyVault"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `flushModel` | `claude-haiku-4-5-20251001` | Summariser model |
| `maxConversationTurns` | `20` | Transcript turns to include |
| `obsidianDailyNotesSubdir` | `"Daily"` | Vault subdirectory |
| `obsidianVaultPath` | — | Absolute path to Obsidian vault |

---

## Configuration

### Safety config — `~/.pi/engineering-team/safety.json`

Created on first run. Defaults:

```json
{
  "hardBlockers": { "enabled": true, "alwaysOn": true },
  "planMode": { "defaultOn": true },
  "classification": {
    "mode": "default-deny",
    "safeAllowlistExtend": [],
    "destructiveOverride": []
  },
  "approvalAuthority": "judge",
  "exemptPaths": ["./tmp/**", "./.pi/engineering-team/runs/**"],
  "tokenTtlSeconds": 300,
  "allowRunLifetimeScope": false
}
```

| Field | Description |
|-------|-------------|
| `hardBlockers.enabled` | Layer A on/off |
| `planMode.defaultOn` | New runs start in plan-mode |
| `classification.mode` | `default-deny` or `default-allow` |
| `approvalAuthority` | Which agent can call `GrantApproval` |
| `tokenTtlSeconds` | Approval token lifetime cap |
| `allowRunLifetimeScope` | Allow `scope: "run-lifetime"` tokens |

### Model routing — `~/.pi/engineering-team/model-routing.json`

Override the model for any agent. The string is passed verbatim to `pi -p --model`, so use whatever format your Pi setup expects.

```json
{
  "overrides": {
    "judge": "github-copilot/claude-opus-4.5",
    "implementer": "github-copilot/claude-sonnet-4.5"
  }
}
```

Common formats:
- `zenmux/anthropic/claude-opus-4.6` — ZenMux gateway
- `github-copilot/claude-sonnet-4.5` — GitHub Copilot OAuth
- `anthropic/claude-opus-4.7` — direct Anthropic

Invalid override entries (non-string, > 256 chars, etc.) are dropped at load with a stderr warning rather than crashing dispatch.

### Rate limits — `~/.pi/engineering-team/rate-limits.json`

Per-provider request + token budgets enforced by `RateLimitGuard`. Backward-clock-jump tolerant (NTP correction won't false-block).

### Teams config — `~/.pi/engineering-team/teams.yaml` (+ `teams.local.yaml`)

Per-agent domain policies (read / upsert / delete paths, `bash_policy`, `force_block`). Project-level overrides live in `<cwd>/.pi/engineering-team/teams.local.yaml`. Parse errors force mode to `block` and surface the path + error at boot.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_ENGINEERING_SERVER_PORT` | `4747` | Observability server port |
| `PI_ENGINEERING_EVENT_URL` | — | Remote HTTP sink for events (optional) |
| `PI_ENGINEERING_AGENT_MODE` | — | Set to `"1"` inside spawned agent subprocesses (host-managed; do not set manually) |
| `PI_ENGINEERING_RUN_ID` | — | Set inside agent subprocesses (host-managed) |
| `PI_ENGINEERING_RUNS_DIR` | — | Set inside agent subprocesses (host-managed) |

Sensitive directories (`~/.pi/engineering-team/`, `runs/`, `approvals/`) are chmod'd to `0o700` at boot.

---

## Architecture

```
Pi coding agent
└── pi-engineering extension (src/index.ts via jiti; or dist/index.js)
    ├── ADWEngine          workflow orchestration · run state machine · DAG resolver
    ├── TeamRuntime        per-step agent subprocess spawn · prompt assembly · tool injection
    ├── MessageBus         typed pub/sub
    ├── SafetyGuard        four-layer tool-call interceptor (A/B/C/D)
    ├── RateLimitGuard     per-provider token+request budget
    ├── SecretsVault       OS-keyring-backed vault + scrubber
    ├── MemoryCore         session summariser + wisdom buffer + Obsidian sync
    ├── Observer           event emission → JSONL + optional HTTP sink
    └── Commands           /run-*, /eng-plan, /spec, /issue, /consult, …

Observability server (dist/server.cjs — CJS, spawned as child process)
    ├── Fastify HTTP API   /health, /runs, /runs/:id/events, /stats
    ├── EventWatcher       tails runs/<runId>/events.jsonl → SQLite (inode-aware)
    └── SQLite DB          ~/.pi/engineering-team/server/engineering-team.sqlite
```

Agents are not pre-booted. Each step's `TeamRuntime.deliver()` spawns a fresh `pi -p` subprocess in its own process group (`detached: true`), with a 10-min timeout and SIGTERM → SIGKILL escalation.

### Directory layout

```
~/.pi/
├── agent/
│   ├── extensions/pi-engineering.js   ← ESM bundle (build install only)
│   └── agents/engineering-*.md        ← agent definitions
└── engineering-team/                  ← 0o700
    ├── server.cjs                     ← CJS observability server
    ├── better_sqlite3.node            ← native SQLite addon
    ├── server/engineering-team.sqlite ← observability DB
    ├── safety.json                    ← auto-created
    ├── model-routing.json             ← optional
    ├── memory.json                    ← auto-created
    ├── teams.yaml                     ← agent domain policies (user)
    ├── runs/                          ← 0o700
    │   └── <runId>/
    │       ├── state.json             ← run state (atomic tmp+rename)
    │       ├── events.jsonl           ← append-only event log (rotated at 50 MB)
    │       ├── tasks.json             ← shared task list (locked + atomic)
    │       ├── .secret                ← HMAC key for approval tokens (0o600)
    │       └── approvals/             ← 0o700
    │           ├── pending/<id>.json  ← incoming requests
    │           ├── <id>.json          ← granted tokens (0o600)
    │           └── <id>.json.consumed ← spent once-tokens
    ├── verifier-scripts/              ← active verifier scripts
    │   ├── .staging/                  ← learner stages here
    │   ├── .versions/                 ← archived prior versions
    │   └── .fixtures/                 ← test fixtures
    ├── expertise/                     ← curated wisdom (Memory Core only)
    └── second-brain/
        ├── scripts/                   ← flush.mjs + helpers
        └── logs/YYYY-MM-DD.md         ← daily session logs

<project-cwd>/.pi/engineering-team/
├── teams.local.yaml                   ← project-level domain overlay
└── active-run.json                    ← per-project pause state for /spec
```

---

## Development

### Project structure

```
src/
├── index.ts                ← extension entry (AGENT_DEFS, boot)
├── types.ts                ← shared types
├── config.ts               ← safety + model-routing loaders
├── commands/               ← slash-command handlers
├── workflows/              ← state-machine workflows (one file per workflow)
├── adw/                    ← ADWEngine, RunState, BudgetGuard, TillDoneFooter, ActiveRun, DagResolver
├── team/                   ← TeamRuntime, MessageBus, modelProvider, tools/
├── safety/                 ← SafetyGuard, classifier, approvals, DomainLock, paths, patterns, prompt-fence
├── rateLimit/              ← RateLimitGuard + config
├── secrets/                ← Vault, UseSecret, patterns, spawn, Crypto, MasterKey, Integration
├── observer/               ← Observer, EventWriter, HttpSink
├── memory/                 ← MemoryCore, snapshot, spawnFlush, ExpertiseStore
├── learner/                ← LearnerOrchestrator (verifier-gap → staged promotion)
├── verifier/               ← VerifierLoop (read-only claim atomiser)
├── ui/                     ← QuestionWizard, PasswordInput
├── util/                   ← file-lock
└── assets/second-brain/    ← scripts copied to ~/.pi/...

server/
├── index.ts                ← server entry (CJS)
├── server.ts               ← Fastify app builder
├── routes.ts               ← REST endpoints (bounded pagination)
├── dashboard.ts            ← HTML dashboard
├── storage.ts              ← SQLite CRUD
└── watcher.ts              ← inode-aware EventWatcher

agents/                     ← agent markdown definitions (23 files)
scripts/
├── install.sh
├── uninstall.sh
├── postinstall.mjs
├── check-server-bundle.mjs ← pre-commit guard ensures dist/ matches src/
└── install-git-hooks.mjs
.githooks/pre-commit        ← rebuild + validate server bundle on every commit
tsup.config.ts              ← two-target build (ESM extension + CJS server)
```

### Scripts

```bash
pnpm build                  # tsup: ESM extension + CJS server
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run (840+ tests)
pnpm test:watch             # vitest --watch
pnpm engineering:install    # pnpm build && bash scripts/install.sh
pnpm install:git-hooks      # wire up .githooks/pre-commit
```

### Adding a workflow

1. Create `src/workflows/my-workflow.ts` implementing the `Workflow` interface.
2. Register it in `src/index.ts` `workflowMap`.
3. Optionally add a shortcut in `src/commands/workflow-shortcuts.ts`.
4. Every `team.deliver(...)` call **must** pass `{ runId: ctx.run.runId }` so parallel runs don't cross-bind.

### Adding an agent

1. Create `agents/my-agent.md` with the system prompt.
2. Add to `AGENT_DEFS` in `src/index.ts` with `name`, `model`, `systemPrompt`, `team`, and an explicit `tools: [...]` allowlist (Layer D enforces this).
3. If the agent should be reachable via a Lead, mention it in that Lead's prompt.
4. If it needs to write outside the default workspace, add a domain policy entry in `teams.yaml`.

### Build system

| Target | Format | Externals | Bundled |
|--------|--------|-----------|---------|
| Extension (`src/index.ts`) | ESM | `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` | `shell-quote`, `@sinclair/typebox` |
| Server (`server/index.ts`) | CJS | `better-sqlite3` (native addon) | `fastify` |

`@mariozechner/pi-tui` is injected by Pi's extension loader as a virtual module and must not be bundled. `better-sqlite3` ships a native `.node` binary resolved via the `nativeBinding` option (bypassing the `bindings` package).

The pre-commit hook (`.githooks/pre-commit`) rebuilds and validates `dist/server.cjs` so the checked-in bundle is never stale.

---

## End-to-End Walkthrough

```
1. Extension load
   └── Pi transpiles src/index.ts; AGENT_DEFS registered; SafetyGuard installed;
       RateLimitGuard initialised; MemoryCore hooks attached; SIGINT/SIGTERM
       cleanup registered with 2 s timeout.

2. /eng-plan "add rate limiting to the API gateway"
   └── workflow-shortcuts.ts parses the goal
   └── ADWEngine.startRun({ workflow: "plan-build-review", goal, budget: {} })
       └── Workflow defaults merged with command overrides
       └── state.json written via atomic tmp+rename; active-run.txt updated atomically
       └── lifecycle:run_started emitted

3. Step: "plan"
   └── TillDone footer shows "planner [● plan · ○ build · ○ review]"
   └── TeamRuntime.deliver("planner", message, { runId, hostStep: "plan" })
       1. Build system prompt (base + team context + expertise + system notes)
       2. RateLimitGuard.acquire(provider) reserves capacity
       3. spawn("pi", ["-p", "--no-session", "--model", …], {
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
            env: <allowlisted + PI_ENGINEERING_*>,
          })
       4. SafetyGuard inside subprocess intercepts every tool_call:
          A: hard-block rm -rf / sudo / _agent_tmp / tasks.json
          B: plan-mode read-only when active (reads PI_ENGINEERING_RUN_ID)
          C: default-deny classification for Bash/Write/Edit (16 KB cap)
          D: per-agent tool allowlist + domain write paths (force_block on Leads)
       5. Planner calls TaskUpdate, then VerdictEmit("plan","PASS",artifacts=["plan.md"])
       6. Verdict file stat-checked (< 256 KB) + JSON.parse + schema-validate + canonicalize
       7. Artifact paths realpath-resolved + contained under cwd/runDir
   └── Verdict routes to "build"

4. Step: "build"
   └── Implementer calls RequestApproval("bash", "npm install express-rate-limit", "new dep")
       → pending/<id>.json written (0o600); subprocess exits with NEEDS_MORE
   └── ADWEngine routes a follow-up to "judge"
   └── Judge calls GrantApproval(requestId)
       → atomic rename pending → granted
       → HMAC-SHA256 sign over (runId:tokenId:op:argsHash:expiresAt)
       → 0o600 token file written
   └── ADWEngine resumes implementer; new subprocess sees the token
   └── Implementer calls Bash("npm install …") with tokenId
       → Layer C: timingSafeEqual(HMAC) + runId match + atomic-consume
   └── VerdictEmit("build","PASS",artifacts=["src/middleware/rateLimit.ts"])

5. Step: "review"
   └── Reviewer runs 3 evidence gates (test output, LSP diagnostics, acceptance)
   └── VerdictEmit("review", "FAIL", issues=["missing test coverage", …])
       → Issues fenced as <<<UNTRUSTED_REVIEWER_ISSUES_BEGIN>>> ... <<<END>>>
         (per-call CSPRNG nonce + control-char strip + 4 KB cap)
   └── ADWEngine ends run with status "failed"
       (or routes back into the fix loop in plan-build-review-fix)

6. Run complete
   └── Observer JSONL written for every tool call, message, verdict, budget tick
       (50 MB rotation, 10-file retention, 1000-event queue cap)
   └── MemoryCore captures wisdom from VerdictEmits (run cache LRU-capped at 500)
   └── /observe → dashboard at http://127.0.0.1:4747 shows the full trace
   └── At session end the daily log is appended to second-brain/logs/YYYY-MM-DD.md
       (LLM call inside Pi process; flush.mjs spawned detached for file I/O)
```
