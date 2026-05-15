# pi-engineering

A [Pi coding agent](https://pi.dev) extension that wires a multi-agent engineering team into your Pi session. Agents communicate over a message bus, execute structured workflows, and are kept safe by a four-layer safety guard with cryptographic approval tokens. Runs on the Pi Agent SDK — credentials are resolved through Pi's `ModelRegistry`, so any configured provider (Claude Code subscription, GitHub Copilot, OpenAI, …) works transparently.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Installation](#installation)
- [Commands](#commands)
- [Workflows](#workflows)
- [Agent Roster](#agent-roster)
- [Custom Tools](#custom-tools)
- [Safety System](#safety-system)
- [Observability Server](#observability-server)
- [Memory Core](#memory-core)
- [Configuration](#configuration)
- [Development](#development)
- [How It Works End-to-End](#how-it-works-end-to-end)

---

## Overview

pi-engineering gives Pi a persistent team of specialist agents — planner, implementer, reviewer, architect, security auditor, and more — that collaborate on software tasks. You describe a goal; the planner decomposes it; specialists execute steps; a judge gates destructive operations.

**Key capabilities:**

- 12 built-in workflows (plan → build → review, spec → design → plan → build → review, issue analysis, debug, triage, migrate, refactor, docs, fix-loop, and more)
- 23 agents organised into a three-tier hierarchy: an Orchestrator routes to four team Leads (planning, engineering, validation, investigation), who delegate to 18 specialist workers
- Cross-team adversarial `/consult` workflow — parallel Lead positions, optional revision rounds, synthesised verdict
- Inter-agent messaging via a typed pub/sub message bus; agents are spawned on-demand as Pi subprocesses per step (no boot step required)
- Four-layer safety guard: hard blockers (Layer A), plan-mode (Layer B), default-deny classification (Layer C), and per-agent domain lock (Layer D)
- Cryptographic approval-token gate (HMAC-SHA256) for destructive operations; Judge is the sole signing authority
- Built-in secrets vault with leak-scrub and a Verifier→Learner pipeline that promotes new verifier scripts behind staged Judge approval
- SQLite-backed observability server with a web dashboard and a real-time TillDone footer in Pi's TUI
- Memory Core: automatic session summarisation into daily logs with wisdom capture, and optional Obsidian vault sync
- Per-provider rate-limit guard (Anthropic, OpenAI, Google, Mistral) sourced from `~/.pi/engineering-team/rate-limits.json`
- Runs on the **Pi Agent SDK** — credentials are resolved through Pi's `ModelRegistry`, so Claude Code subscription, GitHub Copilot, OpenAI, or any other configured provider works transparently with no separate API key
- Loads directly from TypeScript source via Pi's built-in transpiler (`pi install`) or as a pre-built ESM bundle (`pnpm engineering:install`)

---

## Architecture

```
Pi coding agent
└── pi-engineering extension (src/index.ts via jiti on pi install; dist/index.js on build install)
    ├── ADWEngine          workflow orchestration / run state machine / DAG resolver
    ├── TeamRuntime        per-step agent subprocess spawn + system-prompt assembly + tool injection
    ├── MessageBus         typed pub/sub (agent → agent or broadcast)
    ├── SafetyGuard        four-layer tool-call interceptor (hard / plan-mode / classification / domain-lock)
    ├── RateLimitGuard     per-provider token+request budget gate
    ├── SecretsVault       OS-keyring-backed vault + leak scrubber
    ├── MemoryCore         session summariser + wisdom buffer + Obsidian sync
    ├── Observer           event emission to disk + optional HTTP sink
    └── Commands           /run-*, /plan, /fix, /debug, /spec, /issue, /consult,
                           /workflows, /learn, /observe, /engineering-doctor, /secret-*

Observability server (dist/server.cjs — CJS, spawned as child process)
    ├── Fastify HTTP API   /health, /runs, /runs/:id/events, /stats
    ├── EventWatcher       tails runs/<runId>/events.jsonl → SQLite
    └── SQLite DB          ~/.pi/engineering-team/server/engineering-team.sqlite
```

Agents are not pre-booted at extension load. Each step's `TeamRuntime.deliver()` spawns a fresh Pi subprocess (`pi -p --no-session --model <model> --append-system-prompt <prompt> <message>`), passes the assembled system prompt + run context via env vars, waits for the subprocess to emit a `VerdictEmit` payload to disk, and then exits. This keeps agent state ephemeral and gives the controller deterministic teardown semantics.

### Directory layout at runtime

```
~/.pi/
├── agent/
│   ├── extensions/
│   │   └── pi-engineering.js        ← ESM bundle (build workflow only; pi install uses source directly)
│   └── agents/
│       └── engineering-*.md         ← agent definition files
└── engineering-team/
    ├── server.cjs               ← CJS observability server
    ├── better_sqlite3.node      ← native SQLite addon
    ├── server/
    │   └── engineering-team.sqlite       ← observability DB
    ├── safety.json              ← safety config (auto-created)
    ├── model-routing.json       ← model overrides (optional)
    ├── runs/
    │   └── <runId>/
    │       ├── state.json       ← run state (workflow, step, budget)
    │       ├── events.jsonl     ← append-only event log
    │       ├── tasks.json       ← shared task list
    │       ├── .secret          ← HMAC key for approval tokens
    │       └── approvals/
    │           ├── pending/     ← requests waiting for judge
    │           └── *.json       ← granted approval tokens
    └── second-brain/
        ├── scripts/
        │   ├── flush.mjs        ← standalone flush script (spawned detached)
        │   └── lib/
        │       ├── logWriter.mjs    ← buildSessionEntry / appendOrReplaceSession
        │       ├── transcript.mjs   ← readLastNTurns
        │       └── config.mjs       ← loadConfig / expandTilde
        └── logs/
            └── YYYY-MM-DD.md    ← daily session logs (appended per flush)

<project-cwd>/
└── .pi/
    └── engineering-team/
        └── active-run.json  ← per-project pause state for /spec (runId, phase, stepName)
```

---

## Installation

### Prerequisites

- [Pi coding agent](https://pi.dev) installed
- Node.js ≥ 20

### Install via Pi (recommended)

```bash
pi install https://github.com/sartoris-digital/pi-engineering
```

Pi clones the repo, runs `npm install`, and automatically executes `scripts/postinstall.mjs` which:

| Action | Details |
|--------|---------|
| Builds the server bundle | `tsup server/index.ts → dist/server.cjs` |
| Installs server | `dist/server.cjs` → `~/.pi/engineering-team/server.cjs` |
| Installs native addon | `better_sqlite3.node` → `~/.pi/engineering-team/better_sqlite3.node` |
| Installs agents | `agents/*.md` → `~/.pi/agent/agents/engineering-*.md` |

Pi loads the extension directly from `src/index.ts` via its built-in TypeScript transpiler — no separate build step required. Restart Pi and the team is registered automatically; run `/workflows` to list the available shortcuts or jump straight into `/plan "<goal>"`.

### Install from source (pnpm)

```bash
git clone https://github.com/sartoris-digital/pi-engineering
cd pi-engineering
pnpm install   # also runs postinstall automatically
```

Or to use the pre-built extension bundle instead of jiti/source loading:

```bash
pnpm engineering:install   # pnpm build && bash scripts/install.sh
```

### Uninstall

```bash
bash scripts/uninstall.sh
```

---

## Commands

The extension surfaces 32 slash commands. There is no longer a team-start / team-stop step — agents are spawned per workflow step as needed.

### Run management

| Command | Usage | Description |
|---------|-------|-------------|
| `/run-start` | `/run-start <workflow> "<goal>" [maxIter] [maxCost]` | Start a workflow run by ID. |
| `/run-status` | `/run-status <runId>` | Show current status, step, iteration, budget, and TillDone task progress for a run. |
| `/run-resume` | `/run-resume <runId>` | Resume a paused or interrupted run. |
| `/run-cancel` | `/run-cancel <runId>` | Request graceful cancellation at the next step boundary. Run state is preserved. |
| `/run-abort` | `/run-abort <runId>` | Deprecated alias for `/run-cancel`. |
| `/run-rollback` | `/run-rollback <runId>` | Wipe a run's directory, leaving only `cancelled.log`. Use when `/run-cancel` didn't take. |
| `/run-plan-mode` | `/run-plan-mode on\|off` | Toggle plan mode (read-only) for the active run. |

### Workflow shortcuts

Shortcuts let you invoke workflows with a natural-language goal. Each command takes the goal as a free-text argument — no workflow IDs to remember.

| Command | Workflow | Description |
|---------|----------|-------------|
| `/issue <id>` | `issue-analyze` | Fetch a GitHub, Azure DevOps, or Jira ticket and extract structured requirements into `issue-brief.md`. Detects tracker from AGENTS.md / CLAUDE.md when not explicit. |
| `/spec <goal>` | `spec-plan-build-review` | Discover requirements with an interactive wizard, write a spec and plan for human approval, then build and review. |
| `/plan <goal>` | `plan-build-review` | Plan and implement a feature, then review for correctness. **Note**: Pi resolves duplicate slash-command registrations by suffixing later ones (`plan:1`, `plan:2`, …) and matches on the suffixed name. If another installed extension also registers `/plan` (e.g. `oh-my-pi`), our handler will be silently shadowed — use `/eng-plan` instead. |
| `/eng-plan <goal>` | `plan-build-review` | Collision-free alias for `/plan`. Use this when other extensions also register `/plan`. |
| `/plan-fix <goal>` | `plan-build-review-fix` | Plan and implement a feature with a self-healing review+fix loop. |
| `/investigate <incident>` | `investigate` | Gather incident context, build a hypothesis tree, and gate on judge review. |
| `/triage <bug>` | `triage` | Classify a bug report, assign severity, and route to the right owner. |
| `/verify <module>` | `verify` | Audit code coverage, write missing tests, validate correctness. |
| `/debug <problem>` | `debug` | Gather context, perform root cause analysis, and propose fix options. |
| `/fix <issue>` | `fix-loop` | Analyze a failing test or bug, implement a fix, and iterate until tests pass. |
| `/migrate <goal>` | `migration` | Plan, security-review, implement, and test a database migration. |
| `/refactor <goal>` | `refactor-campaign` | Map, design, implement, verify, and review a large refactor campaign. |
| `/docs <module>` | `doc-backfill` | Audit, plan, write, and review documentation for undocumented code. |

**Examples:**

```
/issue 1234
/issue PROJ-42
/issue https://github.com/org/repo/issues/1234
/spec "Add dark mode toggle to settings"
/plan "Add email/password login with JWT tokens"
/plan-fix "Refactor auth middleware to support OAuth"
/investigate "Production API returning 503s since 14:00 UTC"
/triage "Users on iOS 17 cannot complete checkout — cart empties on payment step"
/verify "The payment processing module in src/payments/"
/debug "Memory usage grows 50 MB/hour in the event processor worker"
/fix "tests/unit/payments.test.ts is failing after the refactor"
/migrate "Add a non-nullable email_verified column to the users table"
/refactor "Break the 900-line UserService into focused domain classes"
/docs "All exported functions in src/api/"
```

| `/workflows` | — | Print the full list of workflows with example usage. |
| `/consult <topic>` | (built per-call) | Cross-team adversarial review. Parallel Lead positions, optional revision rounds, synthesised verdict. Flags: `[teams=eng,valid,invest] [--rounds N]`. |

Run `/workflows` in your Pi session to print this list with full examples.

Once a shortcut starts a run it prints the run ID and three ways to follow progress:

```
▶ plan-build-review started (run a1b2c3d4)
Goal: Add email/password login with JWT tokens

Watch progress:
  /run-status a1b2c3d4-...
  /observe  (dashboard at http://127.0.0.1:4747)
  tail -f ~/.pi/engineering-team/runs/<runId>/events.jsonl
```

### Utilities

| Command | Description |
|---------|-------------|
| `/observe` | Start the observability server on port 4747. |
| `/observe stop` | Stop the observability server. |
| `/engineering-doctor` | Check installation health: extension, runs dir, agent files, safety config. |
| `/learn [runId]` | Process verifier gap logs into new verifier scripts. With no runId, picks the latest run. |

### Secrets vault

The vault is an OS-keyring-backed store (via `@napi-rs/keyring`) used by the `UseSecret` tool. Agents never see raw values — they reference secrets by name and the runtime injects them at execution time.

All vault commands take their input via **non-interactive flags** rather than stdin prompts — Pi's TUI consumes stdin while a command handler runs, so a readline prompt would deadlock the session. For any secret that should not enter chat / terminal history, write it to a file with restricted permissions and use the `--from-file` form.

| Command | Usage | Description |
|---------|-------|-------------|
| `/secret-set` | `/secret-set <NAME> [--note "..."] (--value <secret> \| --from-file <path>)` | Store a secret. |
| `/secret-list` | — | List secret names and metadata (never values). |
| `/secret-rm` | `/secret-rm <NAME> --yes` | Delete a secret (the `--yes` flag is the required confirmation). |
| `/secret-rotate` | `/secret-rotate <NAME> (--value <secret> \| --from-file <path>)` | Replace the value of an existing secret. |
| `/secret-export` | `/secret-export "<path>" (--passphrase <pp> \| --passphrase-from-file <p>) --yes` | Encrypted vault backup. |
| `/secret-import` | `/secret-import <path> (--passphrase <pp> \| --passphrase-from-file <p>) [--on-conflict overwrite\|skip\|abort]` | Import from an encrypted export (default `--on-conflict skip`). |
| `/secret-scrub` | `/secret-scrub <NAME> (--value <leaked> \| --from-file <path>)` | Vault a leaked secret **and** retroactively scrub it from all run and log files. |

Example — store a token without it landing in chat history:

```bash
# Put the value in a file with restricted perms, then load it.
umask 077 && printf '%s' "$YOUR_REAL_TOKEN" > /tmp/secret.txt
# Inside Pi:
/secret-set MY_API_KEY --note "Production API" --from-file /tmp/secret.txt
shred -u /tmp/secret.txt
```

The scrubber also runs proactively: a regex set in `src/secrets/patterns.ts` (Anthropic `sk-ant-*`, OpenAI `sk-proj-*` / `sk-*`, GitHub `github_pat_*` / `ghp_*` / `gho_*`, etc.) is matched against every captured event so leaked credentials are caught at write time, not after-the-fact.

---

## Workflows

Workflows are state machines where each step dispatches a goal to an agent, waits for a `VerdictEmit` tool call (`PASS` / `FAIL` / `NEEDS_MORE`), and routes to the next step based on the verdict.

### Built-in workflows

| ID | Steps | Description |
|----|-------|-------------|
| `issue-analyze` | analyze | Fetch a ticket from GitHub Issues, Azure DevOps, or Jira; extract requirements; write `issue-brief.md` with a suggested downstream workflow. |
| `spec-plan-build-review` | discover → design → plan → build → review | Interactive discovery wizard → spec (human-gated) → implementation plan (human-gated) → build → review. |
| `plan-build-review` | plan → build → review | Decompose a goal, implement it, review for correctness and quality. |
| `plan-build-review-fix` | plan → build → review → fix → review | Same as above with an automatic fix loop on review failures. |
| `investigate` | gather-context → analyze → report | Open-ended investigation of a system or behaviour. |
| `triage` | classify → route → judge-gate | Classify a bug report, assign severity and ownership, get judge sign-off. |
| `verify` | gather-context → check → judge-gate | Verify correctness of an existing change. |
| `debug` | gather-context → analyze → propose-fix → judge-gate | Root cause analysis ending in a fix proposal reviewed by the judge. |
| `fix-loop` | analyze → fix → verify | Iterative fix loop until verification passes. |
| `migration` | plan → implement → verify → judge-gate | Safe database or infrastructure migration with approval gate. |
| `refactor-campaign` | analyze → plan → implement → review | Large-scale refactoring with architectural analysis up front. |
| `doc-backfill` | analyze → draft → review | Generate missing documentation for existing code. |

### `/spec` — gated discovery workflow

`/spec` is distinct from all other shortcuts: it pauses execution at three points to collect human input before continuing.

```
/spec "Add dark mode toggle to settings"

  1. discover   — Discoverer agent writes questions.md
                  → TUI wizard appears (tabbed, no border)
                  → User fills in answers, submits with Ctrl+Enter
                  → answers.md written to run directory

  2. design     — Architect agent reads answers.md, writes spec.md
                  → Pi prints: spec written → <path>
                  → User reviews spec in their editor
                  → User types "approve" to continue

  3. plan       — Planner agent reads spec.md, writes plan.md (with [fast/standard/reasoning] tier hints)
                  → Pi prints: plan written → <path>
                  → User reviews plan in their editor
                  → User types "approve" to start build

  4. build      — Implementer agent executes plan.md (unchanged from /plan)

  5. review     — Reviewer agent inspects changes (unchanged from /plan)
```

**Approval gate:** After `design` and `plan` complete, the run pauses with `status: waiting_user`. Typing `approve`, `approved`, or `looks good` in the Pi prompt resumes execution. Any other input echoes a reminder.

**State:** The active run is tracked in `<project-cwd>/.pi/engineering-team/active-run.json`. This is per-project so simultaneous `/spec` runs in different directories never collide.

### `/issue` — ticket analysis shortcut

`/issue` accepts a raw ticket ID, a numeric issue number, or a full URL and routes to the `issue-analyze` workflow. The command detects the tracker type automatically.

```
/issue 1234                                 # GitHub issue #1234 (auto-detected)
/issue PROJ-42                              # Jira ticket PROJ-42
/issue AB#9876                              # Azure DevOps work item
/issue https://github.com/org/repo/issues/1234   # explicit URL
```

The tracker is resolved in order:
1. URL scheme (github.com → `github`, dev.azure.com → `ado`, *.atlassian.net → `jira`)
2. ID format (`AB#` prefix → `ado`, `[A-Z]+-\d+` → `jira`, bare number → `github`)
3. Project files: `AGENTS.md`, `CLAUDE.md`, `~/.pi/engineering-team/issue-tracker.json`, `git remote -v`

On `PASS` the run directory contains `issue-brief.md` with:
- Ticket metadata (tracker, ID, URL, type, priority, status)
- Extracted problem statement and acceptance criteria
- Suggested downstream workflow (`spec-plan-build-review`, `debug`, `fix-loop`, or `plan-build-review`)
- A one-sentence goal string ready to paste into the suggested shortcut

**Typical follow-up:**

```
/issue 1234
# → reads issue-brief.md, sees Suggested Workflow: fix-loop, Goal: "Fix null pointer in checkout flow"
/fix "Fix null pointer in checkout flow"
```

### How a step works

1. The engine builds a `StepContext` — goal, runId, runsDir, artifacts from previous steps.
2. The context is serialized into a prompt delivered to the designated agent via `MessageBus`.
3. The engine waits up to 10 minutes for the agent to call `VerdictEmit`.
4. After 8 minutes without a verdict, the engine sends a reminder message.
5. The verdict routes to the next step, a retry, or terminates the run.
6. Artifacts emitted by the agent (file paths) are merged into run state and passed to downstream steps.

### Budget

When starting a run you can set limits:

```
/run-start plan-build-review "add search to posts API" 20 5.00
#                                                       ^   ^
#                                               maxIter maxCostUsd
```

The engine checks budget at the start of each iteration. Exhaustion halts the run with `status: "failed"`.

---

## Agent Roster

The team is defined in `agents/*.md` and registered in `src/index.ts` (`AGENT_DEFS`). Each file becomes an agent definition installed to `~/.pi/agent/agents/engineering-*.md`. Agents are spawned on demand by `TeamRuntime.deliver()` as one-shot `pi -p` subprocesses; there is no boot step.

The roster is organised into a three-tier hierarchy:

```
orchestrator (top-level router)
├── planning-lead       ↳ planner · architect · discoverer · codebase-cartographer · knowledge-retriever
├── engineering-lead    ↳ implementer · root-cause-debugger · performance-analyst
├── validation-lead     ↳ reviewer · tester · security-auditor
└── investigation-lead  ↳ incident-investigator · bug-triage · observability-archivist · issue-analyst

cross-functional (no team)
├── judge       — sole approval-token signer
├── verifier    — read-only claim atomiser, runs verifier-scripts
└── learner     — promotes new verifier-scripts behind Judge approval
```

### Orchestrator + Leads

| Agent | Model | Role |
|-------|-------|------|
| `orchestrator` | claude-opus-4.6 | Top-level router. Classifies requests, decomposes into team-shaped tasks, dispatches to Leads in parallel by default, synthesises Lead verdicts back to the user. Never addresses workers directly. |
| `planning-lead` | claude-opus-4.6 | Coordinates planning workers; produces a single team position from their VerdictEmits. |
| `engineering-lead` | claude-opus-4.6 | Coordinates engineering workers; escalates scope expansion back to the Orchestrator. |
| `validation-lead` | claude-opus-4.6 | Coordinates validation workers; a security-auditor Critical/High FAIL is blocking and escalated intact. |
| `investigation-lead` | claude-opus-4.6 | Coordinates investigation workers; incident syntheses must include a Timeline section. |

Leads delegate; they do not execute. Their `Write`/`Edit` access is restricted by Layer D to the consult-artifact directories `<run>/positions/`, `<run>/adversarial/`, and (orchestrator only) `<run>/synthesis.md`.

### Specialist workers

| Agent | Model | Team | Role |
|-------|-------|------|------|
| `planner` | claude-opus-4.6 | planning | Decomposes goals into tasks, writes `plan.md`. Runs a 6-lens requirements gap analysis before producing the plan. |
| `architect` | claude-opus-4.6 | planning | Writes ADR-style spec.md (Problem · Approach · Acceptance Criteria · Key Interfaces · Out of Scope · Open Questions). |
| `discoverer` | claude-haiku-4.5 | planning | Generates 3–5 discovery questions across SCOPE / CONSTRAINTS / SUCCESS / CONTEXT for `/spec`. |
| `codebase-cartographer` | claude-sonnet-4.6 | planning | Builds mental model of existing code, maps modules, dependencies, hotspots. |
| `knowledge-retriever` | claude-sonnet-4.6 | planning | Fetches and summarises code, docs, ADRs, and tickets into `context-pack.md`. |
| `implementer` | claude-sonnet-4.6 | engineering | Writes code with TDD; calls `RequestApproval` for any destructive op. |
| `root-cause-debugger` | claude-opus-4.6 | engineering | 7-stage competing-hypothesis protocol: Observe → Hypothesise → Gather → Rebut → Rank → Synthesise → Probe. Produces `fix-plan.md`. |
| `performance-analyst` | claude-sonnet-4.6 | engineering | Latency, N+1, memory, concurrency review with file:line references. |
| `reviewer` | claude-opus-4.6 | validation | Deep inspection; requires 3 evidence gates (fresh test output, LSP diagnostics, acceptance-criteria coverage) before any verdict. |
| `tester` | claude-sonnet-4.6 | validation | TDD: writes failing test, validates fix, confirms `pnpm test` is clean. |
| `security-auditor` | claude-opus-4.6 | validation | Static analysis, secrets scanning, auth + dependency review. Read-only; Critical/High findings force FAIL. |
| `incident-investigator` | claude-opus-4.6 | investigation | Same 7-stage protocol as root-cause-debugger, with a Timeline section. |
| `bug-triage` | claude-haiku-4.5 | investigation | Classifies P0–P3, deduplicates, assigns owner area. |
| `observability-archivist` | claude-sonnet-4.6 | investigation | Reads run event streams, builds trace timelines, surfaces anomalies. |
| `issue-analyst` | claude-haiku-4.5 | investigation | Fetches tickets from GitHub / ADO / Jira CLIs, writes `issue-brief.md`. |

### Cross-functional

| Agent | Model | Role |
|-------|-------|------|
| `judge` | claude-opus-4.6 | Final verdict authority. The only agent that can call `GrantApproval`. Before voting PASS: runs `git diff`, confirms tests pass, verifies all reviewer issues are addressed. |
| `verifier` | claude-sonnet-4.6 | Read-only verifier. Atomises worker claims and runs deterministic scripts under `~/.pi/engineering-team/verifier-scripts/` via `uv run --script`. Restricted to allowlisted Bash by Layer D. |
| `learner` | claude-opus-4.6 | Privileged on-demand agent that converts verifier gap logs into staged verifier-script upgrades. Three safety gates: domain lock, Judge approval per script, fixture validation before promotion. |

Each agent receives its system prompt from its markdown file plus a team-context footer injected at runtime that lists available tools and teammates. Per-agent tool allowlists in `AGENT_DEFS` are enforced by Layer D at the `tool_call` boundary, not just as prompt metadata.

---

## Custom Tools

All agents receive these tools in addition to the standard Pi built-ins.

### `SendMessage`

Send a message to a named agent or broadcast to all teammates.

| Parameter | Type | Description |
|-----------|------|-------------|
| `to` | string | Recipient agent name or `'*'` for broadcast |
| `summary` | string | One-line summary for observability logs |
| `message` | string | Full message body |
| `requestId` | string? | Optional request ID for response pairing |

### `VerdictEmit`

Signal the completion of a workflow step. **Agents must call this at the end of every step turn.**

| Parameter | Type | Description |
|-----------|------|-------------|
| `step` | string | Step name, e.g. `'build'` or `'review'` |
| `verdict` | `PASS \| FAIL \| NEEDS_MORE` | Outcome |
| `issues` | string[]? | Required when `verdict` is `FAIL` |
| `artifacts` | string[]? | File paths produced in this step |
| `handoffHint` | string? | Escalation routing hint: `'security'`, `'perf'`, `'re-plan'` |
| `learnings` | string[]? | Generalizable insights from this step, accumulated into Memory Core |
| `decisions` | string[]? | Key decisions made and their rationale, accumulated into Memory Core |
| `issues_found` | string[]? | Bugs or problems discovered during the step, accumulated into Memory Core |
| `gotchas` | string[]? | Non-obvious caveats worth remembering, accumulated into Memory Core |

### `TaskList`

List all tasks for the current run (`pending`, `in_progress`, `completed`, `blocked`).

### `TaskUpdate`

Create or update a task.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID |
| `status` | enum | `pending \| in_progress \| completed \| blocked` |
| `notes` | string? | Optional notes |
| `owner` | string? | Owning agent name |

### `RequestApproval`

Request Judge approval before executing a destructive operation. Write the request and **wait** — do not proceed until `GrantApproval` is confirmed.

| Parameter | Type | Description |
|-----------|------|-------------|
| `op` | string | Operation type: `git-push`, `npm-install-new`, `migration`, `bash`, `write`, `edit` |
| `command` | string | The exact command or file path |
| `justification` | string | Why the operation is necessary |

### `GrantApproval`

**Judge only.** Grant an approval token for a pending request.

| Parameter | Type | Description |
|-----------|------|-------------|
| `requestId` | string | The ID from `RequestApproval` |
| `ttlSeconds` | number? | Token TTL in seconds (default 300) |
| `scope` | `once \| run-lifetime` | `once` = single use (default); `run-lifetime` = valid for entire run |

Tokens are HMAC-SHA256 signed and verified by the SafetyGuard on every tool call.

---

## Safety System

Four layers of protection, evaluated in order on every tool call.

### Layer A — Hard blockers (always on)

Certain patterns are always blocked regardless of approval tokens:

- `rm -rf` with root, home, or `.pi` paths
- `sudo` in Bash
- `git push --force` to `main` or `master`
- Writing to `.env`, `.env.*`, `launchd`, `systemd` configs
- Writing to device files
- Worker writes to `<run>/tasks.json` (controller-owned)
- All Lead and Orchestrator writes outside their consult-artifact paths (`force_block`)
- Unsafe agent names at the runtime boundary (must match `[a-z][a-z0-9-]*`)

### Layer B — Plan-mode gate

When `planMode` is enabled in a run's state, agents are restricted to read-only tools: `Read`, `Grep`, `Glob`, `Bash` with safe verbs (`cat`, `ls`, `git status/diff/log`). Any write or execute attempt is blocked.

### Layer C — Default-deny classification

`Bash` execution and file mutations (`Write`, `Edit`) require a valid approval token unless the command is classified as safe.

**Safe commands** (no approval needed): `cat`, `ls`, `find`, `grep`, `git status/diff/log/blame/branch`, test runners, linters, type checkers.

**Destructive commands** (approval required): `npm install` with new packages, `git push`, `git checkout -b`, file redirects, arbitrary script execution.

### Layer D — Per-agent domain lock

Each agent in `AGENT_DEFS` declares an explicit tool allowlist. Layer D enforces it at the `tool_call` boundary inside the agent subprocess — declaring `tools: [...]` on an AgentDefinition is **not** prompt metadata, it's a hard runtime gate. An unknown agent name fails closed for `Bash`, `Write`, `Edit`, `Find`, `UseSecret`, `RequestApproval`, and `GrantApproval`.

Domain policies (per-team write-path restrictions, consult-artifact scopes, verifier-script allowlist for the `verifier` agent) live in `teams.yaml` / `teams.local.yaml` and are loaded at controller boot and inside every subprocess.

### Approval flow

```
Implementer                    Judge
    │                            │
    ├── RequestApproval ─────────►
    │   (writes pending/*.json)  │
    │                            ├── Reviews request
    │                            ├── GrantApproval ──────────►
    │                            │   (writes signed token)   │
    │◄────────────────────────────────── tokenId, expiresAt ─┤
    │                                                         │
    ├── Bash / Write (with tokenId) ──► SafetyGuard verifies
    │                                   HMAC + TTL + scope
    └── Operation executes if valid
```

---

## Observability Server

Start with `/observe`. The server runs on port 4747 (configurable via `PI_ENGINEERING_SERVER_PORT`).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | `{"ok": true}` |
| `GET` | `/` | HTML dashboard |
| `GET` | `/runs` | List runs. Query: `limit`, `offset` |
| `GET` | `/runs/:id` | Single run state |
| `GET` | `/runs/:id/events` | Events for a run. Query: `category`, `since`, `limit`, `offset` |
| `POST` | `/events` | Ingest NDJSON event batch |
| `GET` | `/stats` | Run counts by status, total event count |

### Event categories

| Category | Description |
|----------|-------------|
| `lifecycle` | Run started, step started, step completed, run ended |
| `tool_call` | Every tool invocation with arguments |
| `tool_result` | Tool result (truncated for large outputs) |
| `message` | Agent-to-agent messages via SendMessage |
| `verdict` | VerdictEmit calls |
| `budget` | Budget warnings and exhaustion |
| `safety` | Blocked or approved operations |
| `approval` | RequestApproval and GrantApproval events |
| `error` | Agent errors and step failures |

Events are written to `~/.pi/engineering-team/runs/<runId>/events.jsonl` in real time. The server's `EventWatcher` tails these files and ingests them into SQLite so they can be queried across runs.

---

## Memory Core

Memory Core automatically summarises each Pi session into a daily markdown log so the team's decisions and completed work accumulate over time.

### How it works

At the end of every session (and before each compaction), Memory Core fires a two-stage flush:

1. **Narrative generation** — `MemoryCore.doFlush()` runs inside the Pi process and calls `completeSimple` from `@mariozechner/pi-ai` using credentials resolved via `pi.modelRegistry` (the Pi Agent SDK's live model registry). This means the summary uses **whatever provider and model the user has configured in Pi** — Anthropic, GitHub Copilot, OpenAI, or any other — with no separate API key required.
2. **Snapshot + flush script** — The pre-generated narrative is written into a JSON snapshot. `flush.mjs` is spawned detached (fire-and-forget) as a pure I/O script: it writes the narrative to today's daily log (`~/.pi/engineering-team/second-brain/logs/YYYY-MM-DD.md`) and optionally creates an Obsidian symlink. No LLM call is made inside `flush.mjs`.

Separating the LLM call (in-process) from the file I/O (detached) means the summary always uses Pi's configured credentials, and the flush script remains a simple dependency-free Node.js script.

### Daily log format

Each session appends one entry:

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
- Chose sliding window over fixed window to avoid burst traffic at window boundaries

**Gotchas**
- Rate limit headers differ between express-rate-limit v6 and v7

### Summary
<LLM-generated paragraph summarising decisions, blockers, and outcomes>

---
```

The Wisdom section is only present when at least one run in the session emitted `learnings`, `decisions`, `issues_found`, or `gotchas` via `VerdictEmit`. Values are deduplicated across steps and runs within the session.

If the session already has an entry (e.g. after a mid-session compaction), it is replaced in-place rather than duplicated.

### Flush triggers

| Trigger | Pi hook |
|---------|---------|
| Session end | `session_end` |
| Pre-compaction | `session_before_compact` |

### Obsidian vault sync (optional)

Set `obsidianVaultPath` in the memory config to sync daily logs into an Obsidian vault. After each flush the script resolves symlinks on both sides before comparing paths, so macOS `/tmp` → `/private/tmp` aliasing is handled correctly.

### Memory config — `~/.pi/engineering-team/memory.json`

Created automatically the first time the extension loads. Override any field:

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
| `flushModel` | `claude-haiku-4-5-20251001` | Model used to generate session summaries |
| `maxConversationTurns` | `20` | Maximum turns read from the session transcript |
| `obsidianDailyNotesSubdir` | `"Daily"` | Subdirectory inside the vault for daily notes |
| `obsidianVaultPath` | — | Absolute path to your Obsidian vault (optional) |

---

## Configuration

### Safety config — `~/.pi/engineering-team/safety.json`

Created automatically on first run. Override any field:

```json
{
  "hardBlockers": true,
  "planMode": true,
  "classification": "default-deny",
  "approvalAuthority": "judge",
  "exemptPaths": [],
  "tokenTtl": 300,
  "allowRunLifetimeScope": false
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `hardBlockers` | `true` | Enable Layer A (rm -rf, sudo, force-push blocks) |
| `planMode` | `true` | New runs start in plan-mode (read-only) |
| `classification` | `"default-deny"` | Require approval for any unrecognised command |
| `approvalAuthority` | `"judge"` | Which agent can call `GrantApproval` |
| `tokenTtl` | `300` | Approval token lifetime in seconds |
| `allowRunLifetimeScope` | `false` | Allow run-lifetime scope tokens |

### Model routing — `~/.pi/engineering-team/model-routing.json`

Override the model for any agent by name. The override replaces `def.model` from `AGENT_DEFS` in `src/index.ts` for that delivery's `pi -p --model` argument and for the per-provider RateLimitGuard bucket.

The model string is passed to `pi -p --model` verbatim, so use whatever format your Pi setup expects. Examples:
- `zenmux/anthropic/claude-opus-4.6` if you have ZenMux configured as a gateway provider (matches Pi's models.json registry of `anthropic/claude-opus-4.6` under the `zenmux` provider).
- `github-copilot/claude-sonnet-4.5` if you're routing through GitHub Copilot's OAuth.
- `anthropic/claude-opus-4.7` if you have a direct Anthropic provider configured in Pi.

```json
{
  "overrides": {
    "judge": "github-copilot/claude-opus-4.5",
    "implementer": "github-copilot/claude-sonnet-4.5"
  }
}
```

The `AGENT_DEFS` defaults assume a ZenMux setup. If your Pi is configured for a different provider you'll see `model_not_available_for_integrator` errors and agent subprocesses hanging at the 10-minute kill timeout — drop a `model-routing.json` like the example above to redirect.

(The `downshift` field in the schema is config-only at the moment — no engine logic consumes it. Wiring it through `BudgetGuard` is a follow-up.)

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_ENGINEERING_SERVER_PORT` | `4747` | Observability server port |
| `PI_ENGINEERING_TEAM_DATA_DIR` | `~/.pi/engineering-team` | Root data directory |
| `PI_ENGINEERING_EVENT_URL` | — | Remote HTTP sink for events (optional) |

---

## Development

### Project structure

```
src/
├── index.ts                 ← extension entry point (AGENT_DEFS lives here)
├── types.ts                 ← shared types (TeamMessage, RunState, VerdictPayload, …)
├── config.ts                ← safety + model routing config loader
├── commands/
│   ├── run-start.ts
│   ├── run-resume.ts
│   ├── run-cancel.ts
│   ├── run-abort.ts         ← deprecated alias for /run-cancel
│   ├── run-rollback.ts
│   ├── run-plan-mode.ts
│   ├── run-status.ts
│   ├── workflow-shortcuts.ts  ← /plan, /fix, /debug, /workflows, /consult, etc.
│   ├── spec.ts              ← /spec command + input hook
│   ├── spec-utils.ts        ← parseQuestionsFile, formatAnswers
│   ├── issue.ts             ← /issue command (tracker detection + issue-analyze)
│   ├── issue-tracker.ts     ← tracker auto-detection
│   ├── learn.ts             ← /learn — verifier-script promotion entrypoint
│   ├── observe.ts
│   ├── doctor.ts
│   ├── secret-set.ts
│   ├── secret-list.ts
│   ├── secret-rm.ts
│   ├── secret-rotate.ts
│   ├── secret-export.ts
│   ├── secret-import.ts
│   ├── secret-scrub.ts
│   └── secret-shared.ts     ← shared vault helpers
├── ui/
│   └── QuestionWizard.ts    ← tabbed TUI wizard component (used by /spec)
├── workflows/
│   ├── types.ts             ← Workflow, Step, StepContext, StepResult
│   ├── consult.ts           ← /consult — adversarial multi-team review
│   ├── issue-analyze.ts     ← fetch ticket + write issue-brief.md
│   ├── spec-plan-build-review.ts
│   ├── plan-build-review.ts
│   ├── plan-build-review-fix.ts
│   ├── triage.ts
│   ├── debug.ts
│   ├── investigate.ts
│   ├── verify.ts
│   ├── fix-loop.ts
│   ├── migration.ts
│   ├── refactor-campaign.ts
│   └── doc-backfill.ts
├── adw/
│   ├── ADWEngine.ts         ← run lifecycle, step dispatch, verdict routing
│   ├── ActiveRun.ts         ← active-run.json read/write/clear helpers
│   ├── DagResolver.ts       ← parallel-step DAG validation + resolution
│   ├── ConversationProjection.ts
│   ├── TillDoneFooter.ts    ← live task-progress footer in Pi's TUI
│   ├── RunState.ts          ← atomic state persistence
│   └── BudgetGuard.ts       ← iteration / cost / time / token limits
├── team/
│   ├── TeamRuntime.ts       ← per-step agent subprocess spawn + tool injection
│   ├── MessageBus.ts        ← typed pub/sub
│   ├── modelProvider.ts     ← model-ID → provider (anthropic/openai/google/…)
│   └── tools/
│       ├── SendMessage.ts
│       ├── VerdictEmit.ts
│       ├── TaskList.ts      ← also exports TaskUpdate
│       ├── RequestApproval.ts
│       └── GrantApproval.ts
├── safety/
│   ├── SafetyGuard.ts       ← four-layer tool-call interceptor
│   ├── classifier.ts        ← command classification (safe/destructive/blocked)
│   ├── approvals.ts         ← HMAC-SHA256 token sign/verify
│   ├── DomainLock.ts        ← Layer D per-agent domain policies
│   ├── HardBlockers.ts      ← Layer A hard-block registry
│   ├── PlanMode.ts
│   ├── paths.ts
│   └── patterns.ts
├── rateLimit/
│   ├── RateLimitGuard.ts    ← per-provider token+request budget gate
│   └── config.ts            ← loadRateLimitConfig from ~/.pi/.../rate-limits.json
├── secrets/
│   ├── Integration.ts       ← wires UseSecret tool + scrubber into Pi
│   ├── UseSecret.ts         ← agent-facing tool
│   ├── Vault.ts             ← OS-keyring-backed store
│   ├── Scrubber.ts          ← scans run/log files for leaked patterns
│   ├── patterns.ts          ← Anthropic / OpenAI / GitHub / etc. leak regex
│   └── …                    ← export, import, list, set, rotate, rm command backends
├── observer/
│   ├── Observer.ts          ← event emission
│   ├── EventWriter.ts       ← JSONL writer
│   ├── HttpSink.ts          ← optional remote sink
│   └── schema.ts            ← event type definitions
├── memory/
│   ├── MemoryCore.ts        ← run cache, flush orchestration, Pi hook registration
│   ├── snapshot.ts          ← writeSnapshot() — serialises flush payload to temp JSON
│   ├── spawnFlush.ts        ← ensureScriptsInstalled(), spawnFlush() detached spawn
│   └── config.ts            ← loadMemoryConfig(), MEMORY_DEFAULTS, expandTilde()
├── learner/                 ← verifier-gap classification + staged-promotion logic
├── verifier/                ← VerifierLoop runtime (read-only claim atomiser)
└── assets/
    └── second-brain/
        └── scripts/
            ├── flush.mjs            ← standalone flush entrypoint
            └── lib/
                ├── logWriter.mjs    ← buildSessionEntry / appendOrReplaceSession
                ├── transcript.mjs   ← readLastNTurns
                └── config.mjs       ← loadConfig / expandTilde

server/
├── index.ts                 ← server entry point (CJS, spawned as child process)
├── server.ts                ← Fastify app builder
├── routes.ts                ← REST endpoints
├── dashboard.ts             ← HTML dashboard
├── storage.ts               ← SQLite CRUD
├── watcher.ts               ← EventWatcher (tails JSONL → SQLite)
└── types.ts                 ← ServerOptions

agents/                      ← agent markdown definitions (23 files)
scripts/
├── install.sh
├── uninstall.sh
└── postinstall.mjs
tsup.config.ts               ← two-target build (ESM extension + CJS server)
```

### Scripts

```bash
pnpm build                  # tsup: ESM extension + CJS server
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run
pnpm test:watch             # vitest --watch
pnpm engineering:install        # pnpm build && bash scripts/install.sh
node scripts/postinstall.mjs  # build server + copy artifacts (runs automatically on install)
```

### Adding a new workflow

1. Create `src/workflows/my-workflow.ts` implementing the `Workflow` interface.
2. Register it in `src/index.ts` in the `workflowMap`.
3. Add a shortcut in `src/commands/workflow-shortcuts.ts` if desired.

### Adding a new agent

1. Create `agents/my-agent.md` with the agent's system prompt and tool permissions (the markdown file is installed to `~/.pi/agent/agents/engineering-<name>.md` by `postinstall.mjs`).
2. Add an entry to `AGENT_DEFS` in `src/index.ts` with `name`, `model`, `systemPrompt`, `team`, and (recommended) an explicit `tools: [...]` allowlist that Layer D will enforce.
3. If the agent should be reachable via a Lead, mention it in that Lead's `systemPrompt` so it is included in the team-context footer.
4. If the agent needs to write outside the default workspace, add a domain policy entry in `teams.yaml` / `teams.local.yaml`.

### Build system

The extension and server are built as two separate tsup targets:

| Target | Format | Key externals | Key bundled |
|--------|--------|--------------|-------------|
| Extension (`src/index.ts`) | ESM | `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` | `shell-quote`, `@sinclair/typebox` |
| Server (`server/index.ts`) | CJS | `better-sqlite3` (native addon) | `fastify` |

Pi loads the extension in an isolated context without access to `node_modules`, so every dependency used by the extension must be either bundled (via `noExternal`) or provided by Pi itself (via `external`). `@mariozechner/pi-tui` is injected by Pi's extension loader as a virtual module and must not be bundled.

`better-sqlite3` ships a native `.node` binary that cannot be bundled. `install.sh` copies it to `~/.pi/engineering-team/better_sqlite3.node` and the server resolves it via the `nativeBinding` constructor option, bypassing the `bindings` package entirely.

---

## How It Works End-to-End

Here is the full flow from a shortcut invocation to a completed run. Agents are not pre-booted — each step spawns its own Pi subprocess.

```
1. Extension load
   └── Pi loads src/index.ts via its built-in transpiler
   └── AGENT_DEFS registered, slash commands registered, SafetyGuard installed,
       RateLimitGuard initialised, MemoryCore hooks attached
       (no team-start step — agents are spawned per-step on demand)

2. /plan "add rate limiting to the API gateway"
   └── workflow-shortcuts.ts parses the goal
   └── ADWEngine.startRun({ workflow: "plan-build-review", goal, budget: {} })
       └── Creates RunState in ~/.pi/engineering-team/runs/<runId>/state.json
       └── Emits lifecycle:run_started event

3. ADWEngine.executeRun(runId) — step: "plan"
   └── TillDone footer shows "planner [● plan · ○ build · ○ review]" in Pi's TUI
   └── ADWEngine builds StepContext (goal, runId, prior artifacts)
   └── TeamRuntime.deliver("planner", message):
       1. Builds the full system prompt (base + team context + expertise + system notes)
       2. RateLimitGuard.acquire(provider) reserves capacity
       3. spawn("pi", ["-p", "--no-session", "--model", "claude-opus-4.6",
                       "--append-system-prompt", <file>, <message>], {env: …})
       4. SafetyGuard (loaded inside the subprocess) intercepts every tool_call
          ── Layer A: hard-block rm -rf / sudo / force-push / tasks.json writes
          ── Layer B: plan-mode allow-list (Read/Grep/Glob/safe Bash) when active
          ── Layer C: default-deny classification for Bash/Write/Edit
          ── Layer D: per-agent tool allowlist + domain write paths
       5. Planner calls TaskUpdate, then VerdictEmit("plan","PASS",artifacts=["plan.md"])
       6. Subprocess exits; controller reads verdict from disk, releases the rate-limit ticket
   └── ADWEngine receives verdict → transitions to "build"

4. Step: "build"
   └── StepContext includes plan.md artifact from previous step
   └── TeamRuntime.deliver("implementer", …) spawns a fresh subprocess
   └── Implementer calls RequestApproval("bash", "npm install express-rate-limit", "new dep")
       → pending/<id>.json written; subprocess exits with NEEDS_MORE
   └── ADWEngine routes a follow-up message to "judge"
   └── Judge calls GrantApproval(requestId) → signed HMAC token stored on disk
   └── ADWEngine resumes the implementer step; the new subprocess sees the token
   └── Implementer calls Bash("npm install express-rate-limit") with tokenId
       → SafetyGuard Layer C verifies HMAC + TTL + scope → allows
   └── Implementer calls VerdictEmit("build","PASS",artifacts=["src/middleware/rateLimit.ts"])

5. Step: "review"
   └── StepContext includes both artifacts
   └── TeamRuntime.deliver("reviewer", …) spawns a fresh subprocess
   └── Reviewer runs its 3 evidence gates (test output, LSP diagnostics, acceptance coverage)
   └── Reviewer calls VerdictEmit("review", "FAIL", issues=["missing test coverage", "…"])
   └── ADWEngine receives FAIL verdict → run ends with status "failed"
       (or routes back into the fix loop if the workflow is plan-build-review-fix)

6. Run complete
   └── Observer has emitted JSONL events for every tool call, message, verdict, budget tick
   └── MemoryCore captures wisdom (learnings / decisions / gotchas) from VerdictEmits
   └── /observe → dashboard at http://127.0.0.1:4747 shows the full trace
   └── At session end the daily log is appended to second-brain/logs/YYYY-MM-DD.md
```
