# pi-engteam

A [Pi coding agent](https://pi.dev) extension that wires a multi-agent engineering team into your Pi session. Agents communicate over a message bus, execute structured workflows, and are kept safe by a three-layer safety guard with cryptographic approval tokens.

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

pi-engteam gives Pi a persistent team of specialist agents — planner, implementer, reviewer, architect, security auditor, and more — that collaborate on software tasks. You describe a goal; the planner decomposes it; specialists execute steps; a judge gates destructive operations.

**Key capabilities:**

- 12 built-in workflows (plan → build → review, spec → design → plan → build → review, issue analysis, debug, triage, migrate, refactor, and more)
- 16 specialist agents, each with a focused system prompt and scoped tool access
- Inter-agent messaging via a typed pub/sub message bus
- Three-layer safety guard: hard blockers, plan-mode gate, and approval-token gate
- SQLite-backed observability server with a web dashboard
- Memory Core: automatic session summarisation into daily logs with wisdom capture, and optional Obsidian vault sync
- Live step-progress labels in Pi's TUI: every agent session shows `agentName [✓ step1 · ● step2 · ○ step3]` while a workflow runs
- Loads directly from TypeScript source via Pi's built-in transpiler (`pi install`) or as a pre-built ESM bundle (`pnpm engteam:install`)

---

## Architecture

```
Pi coding agent
└── pi-engteam extension (src/index.ts via jiti on pi install; dist/index.js on build install)
    ├── ADWEngine          workflow orchestration / run state machine
    ├── TeamRuntime        agent session lifecycle + tool injection + step-progress labels
    ├── MessageBus         typed pub/sub (agent → agent or broadcast)
    ├── SafetyGuard        three-layer tool-call interceptor
    ├── Observer           event emission to disk + optional HTTP sink
    └── Commands           /team-start, /team-stop, /run-*, /observe, /doctor
        └── Workflow shortcuts (/plan, /fix, /debug, …)

Observability server (dist/server.cjs — CJS, spawned as child process)
    ├── Fastify HTTP API   /health, /runs, /runs/:id/events, /stats
    ├── EventWatcher       tails runs/<runId>/events.jsonl → SQLite
    └── SQLite DB          ~/.pi/engteam/server/engteam.sqlite
```

### Directory layout at runtime

```
~/.pi/
├── agent/
│   ├── extensions/
│   │   └── pi-engteam.js        ← ESM bundle (build workflow only; pi install uses source directly)
│   └── agents/
│       └── engteam-*.md         ← agent definition files
└── engteam/
    ├── server.cjs               ← CJS observability server
    ├── better_sqlite3.node      ← native SQLite addon
    ├── server/
    │   └── engteam.sqlite       ← observability DB
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
    └── engteam/
        └── active-run.json  ← per-project pause state for /spec (runId, phase, stepName)
```

---

## Installation

### Prerequisites

- [Pi coding agent](https://pi.dev) installed
- Node.js ≥ 20

### Install via Pi (recommended)

```bash
pi install https://github.com/sartoris-digital/pi-engteam
```

Pi clones the repo, runs `npm install`, and automatically executes `scripts/postinstall.mjs` which:

| Action | Details |
|--------|---------|
| Builds the server bundle | `tsup server/index.ts → dist/server.cjs` |
| Installs server | `dist/server.cjs` → `~/.pi/engteam/server.cjs` |
| Installs native addon | `better_sqlite3.node` → `~/.pi/engteam/better_sqlite3.node` |
| Installs agents | `agents/*.md` → `~/.pi/agent/agents/engteam-*.md` |

Pi loads the extension directly from `src/index.ts` via its built-in TypeScript transpiler — no separate build step required. Restart Pi, then run `/team-start` to boot the team.

### Install from source (pnpm)

```bash
git clone https://github.com/sartoris-digital/pi-engteam
cd pi-engteam
pnpm install   # also runs postinstall automatically
```

Or to use the pre-built extension bundle instead of jiti/source loading:

```bash
pnpm engteam:install   # pnpm build && bash scripts/install.sh
```

### Uninstall

```bash
bash scripts/uninstall.sh
```

---

## Commands

### Team lifecycle

| Command | Description |
|---------|-------------|
| `/team-start` | Boot all agents into idle state. Required before running any workflow. |
| `/team-stop` | Gracefully dispose all agent sessions. |

### Run management

| Command | Usage | Description |
|---------|-------|-------------|
| `/run-start` | `/run-start <workflow> "<goal>" [maxIter] [maxCost]` | Start a workflow run. |
| `/run-resume` | `/run-resume <runId>` | Resume a paused run from where it stopped. |
| `/run-abort` | `/run-abort <runId>` | Abort a running or paused run. |
| `/run-status` | `/run-status <runId>` | Show current state, step, iteration, and budget. |

### Workflow shortcuts

Shortcuts let you invoke workflows with a natural-language goal. Each command takes the goal as a free-text argument — no workflow IDs to remember.

| Command | Workflow | Description |
|---------|----------|-------------|
| `/issue <id>` | `issue-analyze` | Fetch a GitHub, Azure DevOps, or Jira ticket and extract structured requirements into `issue-brief.md`. Detects tracker from AGENTS.md / CLAUDE.md when not explicit. |
| `/spec <goal>` | `spec-plan-build-review` | Discover requirements with an interactive wizard, write a spec and plan for human approval, then build and review. |
| `/plan <goal>` | `plan-build-review` | Plan and implement a feature, then review for correctness. |
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

Run `/workflows` to print the full list with examples in your Pi session.

Once a shortcut starts a run it prints the run ID and three ways to follow progress:

```
▶ plan-build-review started (run a1b2c3d4)
Goal: Add email/password login with JWT tokens

Watch progress:
  /run-status a1b2c3d4-...
  /observe  (dashboard at http://127.0.0.1:4747)
  tail -f ~/.pi/engteam/runs/<runId>/events.jsonl
```

### Utilities

| Command | Description |
|---------|-------------|
| `/observe` | Start the observability server on port 4747. |
| `/observe stop` | Stop the observability server. |
| `/engteam-doctor` | Check installation health: extension, runs dir, agent files, safety config. |

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

**State:** The active run is tracked in `<project-cwd>/.pi/engteam/active-run.json`. This is per-project so simultaneous `/spec` runs in different directories never collide.

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
3. Project files: `AGENTS.md`, `CLAUDE.md`, `~/.pi/engteam/issue-tracker.json`, `git remote -v`

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

The team is defined in `agents/*.md`. Each file becomes an agent definition installed to `~/.pi/agent/agents/engteam-*.md`.

### Core team — spawned at `/team-start`

| Agent | Model | Role |
|-------|-------|------|
| `planner` | claude-opus-4-6 | Decomposes goals into tasks, writes `plan.md`, selects workflow steps. Runs a 6-lens requirements gap analysis (missing questions, undefined guardrails, scope risks, unvalidated assumptions, missing acceptance criteria, edge cases) before writing the plan. |
| `implementer` | claude-sonnet-4-6 | Writes code, scaffolds features, applies project conventions, requests approval for destructive ops |
| `reviewer` | claude-opus-4-6 | Deep code inspection: logic errors, bad abstractions, hidden coupling, regression risk. Requires 3 evidence gates — fresh test output, LSP diagnostics, and acceptance-criteria coverage — before issuing any verdict. |

### Specialist agents — spawned by workflows on demand

| Agent | Role |
|-------|------|
| `issue-analyst` | Fetches issue tickets from GitHub Issues, Azure DevOps, or Jira; detects tracker type; extracts requirements and writes `issue-brief.md` (used by `/issue`) |
| `discoverer` | Reads a goal and produces a structured set of 3–5 discovery questions (used by `/spec` discover step) |
| `architect` | System design, ADR authoring, service boundary and API design |
| `codebase-cartographer` | Builds mental model of existing code, maps modules and dependencies |
| `bug-triage` | Classifies bugs P0–P3, deduplicates, assigns ownership area |
| `incident-investigator` | Pulls logs, traces, and metrics; builds probable-cause hypothesis tree using the same 7-stage competing-hypothesis protocol as `root-cause-debugger`, with a Timeline section in its output. |
| `judge` | Final verdict authority; the only agent that can call `GrantApproval` |
| `knowledge-retriever` | Fetches and summarizes code, docs, ADRs, and tickets |
| `observability-archivist` | Retrieves run history, event logs, and traces |
| `performance-analyst` | Latency, N+1, memory, and concurrency review |
| `root-cause-debugger` | Deep code-path tracing across services, commit correlation. Uses a 7-stage competing-hypothesis protocol: Observe → Hypothesize → Gather evidence → Rebuttal → Rank → Synthesize → Probe. |
| `security-auditor` | Static analysis, secrets scanning, auth and dependency review |
| `tester` | Unit, integration, and regression test authoring; coverage gap analysis |

Each agent receives a system prompt from its markdown file plus a team context footer injected at runtime that lists available tools and teammates.

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

Three layers of protection, evaluated in order on every tool call.

### Layer A — Hard blockers (always on)

Certain patterns are always blocked regardless of approval tokens:

- `rm -rf` with root, home, or `.pi` paths
- `sudo` in Bash
- `git push --force` to `main` or `master`
- Writing to `.env`, `.env.*`, `launchd`, `systemd` configs
- Writing to device files

### Layer B — Plan-mode gate

When `planMode` is enabled in a run's state, agents are restricted to read-only tools: `Read`, `Grep`, `Glob`, `Bash` with safe verbs (`cat`, `ls`, `git status/diff/log`). Any write or execute attempt is blocked.

### Layer C — Default-deny for destructive operations

`Bash` execution and file mutations (`Write`, `Edit`) require a valid approval token unless the command is classified as safe.

**Safe commands** (no approval needed): `cat`, `ls`, `find`, `grep`, `git status/diff/log/blame/branch`, test runners, linters, type checkers.

**Destructive commands** (approval required): `npm install` with new packages, `git push`, `git checkout -b`, file redirects, arbitrary script execution.

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

Start with `/observe`. The server runs on port 4747 (configurable via `PI_ENGTEAM_SERVER_PORT`).

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

Events are written to `~/.pi/engteam/runs/<runId>/events.jsonl` in real time. The server's `EventWatcher` tails these files and ingests them into SQLite so they can be queried across runs.

---

## Memory Core

Memory Core automatically summarises each Pi session into a daily markdown log so the team's decisions and completed work accumulate over time.

### How it works

At the end of every session (and before each compaction), Memory Core fires a two-stage flush:

1. **Narrative generation** — `MemoryCore.doFlush()` runs inside the Pi process and calls `completeSimple` from `@mariozechner/pi-ai` using credentials resolved via `pi.modelRegistry` (the Pi Agent SDK's live model registry). This means the summary uses **whatever provider and model the user has configured in Pi** — Anthropic, GitHub Copilot, OpenAI, or any other — with no separate API key required.
2. **Snapshot + flush script** — The pre-generated narrative is written into a JSON snapshot. `flush.mjs` is spawned detached (fire-and-forget) as a pure I/O script: it writes the narrative to today's daily log (`~/.pi/engteam/second-brain/logs/YYYY-MM-DD.md`) and optionally creates an Obsidian symlink. No LLM call is made inside `flush.mjs`.

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

### Memory config — `~/.pi/engteam/memory.json`

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

### Safety config — `~/.pi/engteam/safety.json`

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

### Model routing — `~/.pi/engteam/model-routing.json`

Override the model for any agent or set budget downshift rules:

```json
{
  "overrides": {
    "implementer": "claude-sonnet-4-6"
  },
  "downshift": {
    "costThreshold": 3.00,
    "fallbackModel": "claude-haiku-4-5-20251001"
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_ENGTEAM_SERVER_PORT` | `4747` | Observability server port |
| `PI_ENGTEAM_DATA_DIR` | `~/.pi/engteam` | Root data directory |
| `PI_ENGTEAM_EVENT_URL` | — | Remote HTTP sink for events (optional) |

---

## Development

### Project structure

```
src/
├── index.ts                 ← extension entry point
├── types.ts                 ← shared types (TeamMessage, RunState, VerdictPayload, …)
├── config.ts                ← safety + model routing config loader
├── commands/
│   ├── team-start.ts
│   ├── team-stop.ts
│   ├── run-start.ts
│   ├── run-resume.ts
│   ├── run-abort.ts
│   ├── run-status.ts
│   ├── workflow-shortcuts.ts
│   ├── spec.ts              ← /spec command + input hook
│   ├── spec-utils.ts        ← parseQuestionsFile, formatAnswers
│   ├── issue.ts             ← /issue command (tracker detection + issue-analyze)
│   ├── observe.ts
│   └── doctor.ts
├── ui/
│   └── QuestionWizard.ts    ← tabbed TUI wizard component (used by /spec)
├── workflows/
│   ├── types.ts             ← Workflow, Step, StepContext, StepResult
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
│   ├── RunState.ts          ← atomic state persistence
│   └── BudgetGuard.ts       ← iteration / cost / time / token limits
├── team/
│   ├── TeamRuntime.ts       ← agent session management + tool injection
│   ├── MessageBus.ts        ← typed pub/sub
│   └── tools/
│       ├── SendMessage.ts
│       ├── VerdictEmit.ts
│       ├── TaskList.ts
│       ├── RequestApproval.ts
│       └── GrantApproval.ts
├── safety/
│   ├── SafetyGuard.ts       ← three-layer tool-call interceptor
│   ├── classifier.ts        ← command classification (safe/destructive/blocked)
│   ├── approvals.ts         ← HMAC-SHA256 token sign/verify
│   ├── PlanMode.ts
│   ├── paths.ts
│   └── patterns.ts
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
├── storage.ts               ← SQLite CRUD
├── watcher.ts               ← EventWatcher (tails JSONL → SQLite)
└── types.ts                 ← ServerOptions

agents/                      ← agent markdown definitions
scripts/
├── install.sh
└── uninstall.sh
tsup.config.ts               ← two-target build (ESM extension + CJS server)
```

### Scripts

```bash
pnpm build                  # tsup: ESM extension + CJS server
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run
pnpm test:watch             # vitest --watch
pnpm engteam:install        # pnpm build && bash scripts/install.sh
node scripts/postinstall.mjs  # build server + copy artifacts (runs automatically on install)
```

### Adding a new workflow

1. Create `src/workflows/my-workflow.ts` implementing the `Workflow` interface.
2. Register it in `src/index.ts` in the `workflowMap`.
3. Add a shortcut in `src/commands/workflow-shortcuts.ts` if desired.

### Adding a new agent

1. Create `agents/my-agent.md` with the agent's system prompt and tool permissions.
2. If the agent needs to be auto-spawned at `/team-start`, add it to the agent list in `src/commands/team-start.ts`.

### Build system

The extension and server are built as two separate tsup targets:

| Target | Format | Key externals | Key bundled |
|--------|--------|--------------|-------------|
| Extension (`src/index.ts`) | ESM | `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` | `shell-quote`, `@sinclair/typebox` |
| Server (`server/index.ts`) | CJS | `better-sqlite3` (native addon) | `fastify` |

Pi loads the extension in an isolated context without access to `node_modules`, so every dependency used by the extension must be either bundled (via `noExternal`) or provided by Pi itself (via `external`). `@mariozechner/pi-tui` is injected by Pi's extension loader as a virtual module and must not be bundled.

`better-sqlite3` ships a native `.node` binary that cannot be bundled. `install.sh` copies it to `~/.pi/engteam/better_sqlite3.node` and the server resolves it via the `nativeBinding` constructor option, bypassing the `bindings` package entirely.

---

## How It Works End-to-End

Here is the full flow from `/team-start` to a completed run:

```
1. /team-start
   └── TeamRuntime spawns Pi agent sessions for each agent
       └── Each session receives: system prompt + custom tools + team context

2. /plan "add rate limiting to the API gateway"
   └── Shortcut command parses goal
   └── ADWEngine.startRun({ workflow: "plan-build-review", goal, budget: {} })
       └── Creates RunState in ~/.pi/engteam/runs/<runId>/state.json
       └── Emits lifecycle:run_started event

3. ADWEngine.executeRun(runId) — step: "plan"
   └── TeamRuntime labels updated: "planner [● plan · ○ build · ○ review]" on all sessions
   └── Builds StepContext (goal, runId, prior artifacts)
   └── MessageBus delivers prompt to "planner" agent
   └── SafetyGuard intercepts all tool calls in real time
       └── Layer A: blocks rm -rf, sudo, force-push
       └── Layer B: plan-mode allows read-only tools only
   └── Planner calls TaskUpdate (writes plan), VerdictEmit("plan", "PASS", artifacts=["plan.md"])
   └── ADWEngine receives verdict → transitions to "build"
   └── TeamRuntime labels updated: "planner [✓ plan · ● build · ○ review]" on all sessions

4. Step: "build"
   └── StepContext includes plan.md artifact from previous step
   └── MessageBus delivers prompt to "implementer" agent
   └── Implementer calls RequestApproval("bash", "npm install express-rate-limit", "new dep")
   └── MessageBus notifies "judge" with approval request
   └── Judge calls GrantApproval(requestId) → signed HMAC token stored on disk
   └── Implementer calls Bash("npm install express-rate-limit") with token
   └── SafetyGuard Layer C: verifies HMAC + TTL → allows
   └── Implementer calls VerdictEmit("build", "PASS", artifacts=["src/middleware/rateLimit.ts"])

5. Step: "review"
   └── StepContext includes both artifacts
   └── MessageBus delivers prompt to "reviewer" agent
   └── Reviewer inspects code, calls VerdictEmit("review", "FAIL", issues=["missing test coverage", "…"])
   └── ADWEngine receives FAIL verdict → run ends with status "failed"

6. Run complete
   └── Observer has emitted events for every tool call, message, verdict, and budget check
   └── /observe → dashboard at http://127.0.0.1:4747 shows full trace
```
