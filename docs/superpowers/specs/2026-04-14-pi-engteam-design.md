# pi-engteam — Design Spec

**Date:** 2026-04-14
**Status:** Draft for review
**Owner:** Nick Collins
**Target:** Pi (pi.dev) extension shipping an autonomous 14-agent engineering team

---

## 1. Goal

Ship a Pi extension (`@sartoris/pi-engteam`) that installs an autonomous software-engineering team of 14 specialized agents capable of running plan → build → review → fix loops until a Judge-approved terminal state is reached, bounded only by explicit budget limits. The team must be:

- **Autonomous**: can run for hours without human intervention, self-correcting against Judge verdicts
- **Safe**: destructive operations gated by hard blockers + plan-mode + Judge-signed approval tokens
- **Observable**: every decision, tool call, message, verdict, and budget event captured in a replayable stream
- **Collaborative**: agents talk to each other directly via an in-process message bus, not just via subagent fan-out
- **Composable**: ships 10+ workflow graphs out of the box; custom workflows drop in as files

Inspiration: `agent-experts` repo (ADWs, hooks, observability), Claude Code `teams` feature (peer messaging, idle lifecycle), Pi SDK (extension runtime, session lifecycle).

## 2. Non-goals (V1)

- Multi-process or multi-host teammates (in-process only)
- Bundled GUI swimlane beyond the server's minimal HTML dashboard
- Human-in-the-loop approval UI (Judge is the approval authority in V1)
- Pi marketplace publication (GitHub + npm only)

---

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Pi host process                                                │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  pi-engteam extension (single TS entry)                   │  │
│  │                                                            │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐  │  │
│  │  │ TeamRuntime │  │ ADW Engine  │  │ SafetyGuard      │  │  │
│  │  │ (sessions + │  │ (runs,      │  │ (hard/plan/      │  │  │
│  │  │  router)    │  │  steps,     │  │  approval)       │  │  │
│  │  │             │  │  verdicts)  │  │                  │  │  │
│  │  └─────────────┘  └─────────────┘  └──────────────────┘  │  │
│  │                                                            │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐  │  │
│  │  │ Observer    │  │ Workflows   │  │ Custom tools     │  │  │
│  │  │ (jsonl +    │  │ (declarative│  │ (SendMessage,    │  │  │
│  │  │  HTTP sink) │  │  graphs)    │  │  TaskList, etc.) │  │  │
│  │  └─────────────┘  └─────────────┘  └──────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
  ~/.pi/engteam/runs/         ~/.pi/engteam/server/
    {runId}/                    engteam.sqlite
      state.json                (optional bundled dashboard)
      events.jsonl
      approvals/
      artifacts/
```

### 3.1 Core building blocks

- **TeamRuntime**: spawns each teammate as an in-process `AgentSession` (via `@mariozechner/pi-coding-agent`); in-memory message bus routes `SendMessage` by name / `*` / `to:idle`; teammates idle after every turn and wake on incoming message
- **ADW Engine**: persistent `RunState` at `.pi/engteam/runs/{runId}/state.json`; declarative step graphs; budget guardrails; resumable; Judge-gated budget extensions
- **SafetyGuard**: three-layer (hard blockers, plan-mode, approval tokens); hooks into `before_agent_start` and `tool_call`
- **Observer**: single append-only event stream per run; hook subscriptions across all Pi lifecycle events; optional HTTP sink via `PI_ENGTEAM_EVENT_URL`; bundled SQLite-backed server for queries/dashboard
- **Workflows**: declarative `Workflow` objects (steps + transitions); loaded from bundled `workflows/` and user `~/.pi/engteam/workflows/`
- **Custom tools**: `SendMessage`, `TaskList`, `TaskUpdate`, `VerdictEmit`, `RequestApproval`, `GrantApproval`, `RunControl`, `AgentSpawn`

### 3.2 The 14 agents

Each ships as a markdown file with frontmatter (`name`, `description`, `tools`, `model`) and body (system prompt). Default models are overridable via `~/.pi/engteam/model-routing.json`.

| Agent | Default model | Primary role |
|---|---|---|
| `planner` | opus | Orchestrator; decomposes goals, selects agents, sequences work |
| `architect` | opus | ADR-style system designs, service boundaries, rollout plans |
| `codebase-cartographer` | sonnet | Maps modules/deps, identifies conventions, hotspots, risk areas |
| `implementer` | sonnet | Writes diff-ready changesets with tests |
| `reviewer` | opus | Deep inspection: logic errors, coupling, dead code, regressions |
| `tester` | sonnet | Unit/integration/regression tests; coverage gap analysis |
| `security-auditor` | opus | Static checks, secret scans, dep/auth issues, compliance |
| `performance-analyst` | opus | Latency, memory, N+1, concurrency, operational fragility |
| `bug-triage` | haiku | Classify, dedupe, severity, route |
| `incident-investigator` | opus | Logs/traces/metrics correlation, probable-cause hypothesis tree |
| `root-cause-debugger` | opus | Code-path analysis, symptom-commit correlation, fix options |
| `judge` | opus | Verdict authority; evaluates completeness/correctness; signs approval tokens |
| `knowledge-retriever` | sonnet | Fetches code/docs/ADRs/tickets for grounded context |
| `observability-archivist` | sonnet | Records decisions, traces, replay state; prompt/policy insights |

---

## 4. TeamRuntime

### 4.1 Lifecycle

1. Extension init → `TeamRuntime` instance created, agents discovered from `~/.pi/agent/agents/engteam-*.md`
2. `/team-start` or first workflow invocation → `TeamRuntime.ensureTeammates(names[])` spawns missing sessions in parallel using `createAgentSession()` from `@mariozechner/pi-coding-agent`. **Important:** when spawning teammates with a project-specific `cwd`, tools must be created via `createCodingTools(cwd)` factory functions — the pre-built `codingTools` instances use `process.cwd()` and will resolve paths incorrectly.
3. Each teammate receives an injected system-prompt suffix (via `DefaultResourceLoader.systemPromptOverride`) that registers its `name`, the `SendMessage` tool, and team-comms conventions
4. Teammates idle after every assistant turn; `TeamRuntime.deliver(msg)` calls `session.prompt(prompt)` with a task-notification XML-wrapped message. Messages queued during an active turn use `session.steer(text)`.
5. On `/run-abort` or Pi shutdown: revoke approval tokens, flush observer, call `session.dispose()` on all teammates
6. **Session events:** Use `session_start` with `event.reason` (`"startup" | "reload" | "new" | "resume" | "fork"`) — the former `session_switch` and `session_fork` events were removed in Pi v0.65.0.
7. **Run resume:** `/run-resume` cannot call session-replacement methods on `AgentSession` directly. Teammate sessions for resumed runs are created via `createAgentSessionRuntime()` with a `CreateAgentSessionRuntimeFactory` that rebuilds cwd-bound services. After replacement, `runtime.session` holds the live session and subscriptions must be rebound.

### 4.2 Message bus

In-memory `MessageBus`:
```ts
type TeamMessage = {
  id: string;
  from: string;                // agent name
  to: string;                  // name | "*" | "planner" | etc.
  summary: string;             // one-line for observability
  message: string;             // full body
  requestId?: string;          // for request/response pairing
  type?: "request" | "response" | "shutdown_request" | "shutdown_response";
  ts: string;
};

interface MessageBus {
  send(msg: TeamMessage): Promise<void>;
  subscribe(name: string, handler: (msg: TeamMessage) => void): void;
  broadcast(msg: Omit<TeamMessage, "to">): Promise<void>;
}
```

Routing rules:
- `to: "name"` → direct delivery; wakes teammate if idle
- `to: "*"` → broadcast to all teammates except sender
- `to: "planner"` and planner is sender → error (no self-messaging)
- Messages delivered in FIFO per-recipient order
- Max queue depth per teammate: 100 (drop-oldest + log when exceeded)

### 4.3 Custom tools registered on every teammate

All custom tools are defined using Pi's `defineTool()` helper (added in v0.65.0), which provides full TypeScript parameter type inference via TypeBox schemas. Tools are passed via `customTools: [...]` in `createAgentSession()`.

- `SendMessage({to, summary, message, requestId?})`: enqueue a `TeamMessage`
- `TaskList()`, `TaskUpdate({taskId, status, notes?, owner?})`: shared task ledger at `.pi/engteam/runs/{runId}/tasks.json`
- `VerdictEmit({step, verdict: "PASS"|"FAIL"|"NEEDS_MORE", issues?, artifacts?, handoffHint?})`: structured verdict — never parse free text
- `RequestApproval({op, args, justification})`: implementer-side approval request
- `GrantApproval({requestId, ttlSeconds?})`: Judge-side token issuance

---

## 5. ADW Engine

### 5.1 RunState

```ts
type RunState = {
  runId: string;
  workflow: string;                    // "plan-build-review-fix" etc.
  goal: string;
  status: "pending" | "running" | "paused" | "succeeded" | "failed" | "aborted";
  currentStep: string;
  iteration: number;
  budget: {
    maxIterations: number;
    maxCostUsd: number;
    maxWallSeconds: number;
    maxTokens: number;
    spent: { costUsd: number; wallSeconds: number; tokens: number };
  };
  steps: Array<{
    name: string;
    startedAt?: string;
    endedAt?: string;
    verdict?: "PASS" | "FAIL" | "NEEDS_MORE";
    issues?: string[];
    handoffHint?: string;
    artifacts?: string[];
    error?: string;
  }>;
  artifacts: Record<string, string>;    // named paths to files/dirs
  approvals: Array<{ tokenId: string; op: string; expiresAt: string; consumed: boolean }>;
  createdAt: string;
  updatedAt: string;
};
```

Persisted at `.pi/engteam/runs/{runId}/state.json`, atomically rewritten after every step transition.

### 5.2 Step contract

```ts
type StepContext = {
  run: RunState;
  team: TeamRuntime;
  observer: Observer;
  engine: ADWEngine;
};

type StepResult = {
  success: boolean;
  verdict: "PASS" | "FAIL" | "NEEDS_MORE";
  issues?: string[];
  artifacts?: Record<string, string>;
  handoffHint?: string;                 // "security" | "perf" | "re-plan" | ...
  error?: string;
};

type Step = {
  name: string;
  required: boolean;
  run: (ctx: StepContext) => Promise<StepResult>;
};
```

Each step dispatches work to one or more teammates via TeamRuntime, waits for a `VerdictEmit`, writes artifacts into `.pi/engteam/runs/{runId}/artifacts/`, and returns a `StepResult`.

### 5.3 Workflow graph

```ts
type Workflow = {
  name: string;
  description: string;
  steps: Step[];
  transitions: Array<{
    from: string;                       // step name
    when: (r: StepResult) => boolean;
    to: string | "halt";
  }>;
  defaults: Partial<RunState["budget"]>;
};
```

The engine loops:
1. Load RunState
2. Select step matching `currentStep`
3. Check budget; if exhausted, ask Judge via `requestBudgetExtension()` (Judge returns new limits or HALT)
4. Run step → StepResult
5. Apply first matching transition; set `currentStep`
6. Persist RunState; emit `lifecycle.step.end` event
7. If terminal (`halt`, `succeeded`, `failed`, `aborted`): finalize, revoke tokens, emit `lifecycle.run.end`

### 5.4 Self-correction patterns

- **Fix loop**: `review` returns FAIL → transition to `fix` → Implementer patches → back to `review`; bounded by `maxIterations`
- **Escalation**: `review.handoffHint === "security"` → routes to `security-audit` step; `"perf"` → `performance-analyze`; `"re-plan"` → back to `plan` with accumulated issues as feedback
- **Budget extension**: when any limit is ≥90% spent, engine pauses and asks Judge to review RunState+verdicts. Judge can grant a one-shot extension (capped at 2× original) or HALT
- **Resume**: `/run-resume <runId>` loads state.json, rebuilds teammate sessions from conversation transcripts, resumes at `currentStep`

### 5.5 Bundled workflows

V1 ships 10 workflows. All are declarative step graphs in `src/workflows/`.

| Name | Steps | Terminal condition |
|---|---|---|
| `plan-build-review` | plan → build → review | Judge PASS on review |
| `plan-build-review-fix` | plan → build → review → (fix → review)* | Judge PASS or iteration ≥ max |
| `investigate` | scope → gather → synthesize | Judge-acceptable report artifact |
| `triage` | classify → dedupe → route | Assigned with confidence ≥0.8 |
| `verify` | plan-tests → write-tests → run → judge | All gates PASS |
| `debug` | reproduce → hypothesize → bisect → fix | Root cause confirmed + fix merged |
| `fix-loop` | fix → review | Judge PASS (resumes into existing run) |
| `migration` | plan → dry-run → safety-check → apply → verify | Verify PASS + rollback plan archived |
| `refactor-campaign` | map → plan-per-file → (patch → review)* | All files PASS or budget halt |
| `doc-backfill` | inventory → prioritize → draft → review | Review PASS on all targets |

Custom workflows: drop a `.ts` file into `~/.pi/engteam/workflows/` exporting a default `Workflow`.

---

## 6. SafetyGuard

Pi extension subscribing to `before_agent_start` and `tool_call`. Three layers:

### 6.1 Layer A — Hard blockers (non-bypassable, no approval can override)

These are never allowed under any circumstance — no Judge token, no plan-mode override, no flag can bypass them. Layer A rules are sourced from `agent-experts/.claude/hooks/pre_tool_use.py` and extended for absolute system protection.

**Absolute-protected paths** (any Read/Write/Edit/Bash operation that targets these, with any verb including read — rationale: even reads of secret stores leak credentials):
- `/etc`, `/usr`, `/bin`, `/sbin`, `/boot`, `/System`, `/Library/System`, `/private/etc`, `/private/var/db`
- `/var/log`, `/var/db`, `/var/root` (macOS + Linux system state)
- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.pgpass`
- macOS keychains: `/Library/Keychains`, `~/Library/Keychains`
- Any path matching `**/id_rsa*`, `**/id_ed25519*`, `**/id_ecdsa*`, `**/*.pem`, `**/*.key`, `**/credentials` (when not inside the project's `test/fixtures/`)
- `.env*` files everywhere except `.env.sample` and `.env.example`

**Absolute-blocked commands** (regardless of path):
- `sudo`, `doas`, `su -`
- `chmod 777`, `chmod -R 777`, `chown` on system paths
- `dd if=* of=/dev/*`, writes to any `/dev/*` device
- `mkfs.*`, `fdisk`, `diskutil erase*`, `parted`
- Recursive deletes with wildcard/parent roots: `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf ~/`, `rm -rf *`, `rm -rf ..`, `rm -rf $HOME`, any `rm -rf` where the resolved path is `/`, `$HOME`, or a direct child of `/`
- `git push --force{,-with-lease}` targeting `main`, `master`, `release/*`, `prod*`
- `git reset --hard` against a pushed commit on a protected branch
- `npm publish`, `pnpm publish`, `yarn publish`, `gh release create`, `gh pr merge --admin`
- Package-manager self-mutation: `npm config set registry`, `~/.npmrc` edits
- Shell init file writes: `~/.zshrc`, `~/.bashrc`, `~/.profile`, `~/.zprofile`, `/etc/profile*`
- Launchd / systemd installs: `launchctl load`, `systemctl enable`, writes under `~/Library/LaunchAgents`, `/Library/LaunchDaemons`, `/etc/systemd`

Hits return `{block: true, reason, layer: "A"}` and emit `category: "safety", type: "block"`. The teammate receives a non-retryable error; the run continues (or halts via Judge depending on workflow policy).

### 6.2 Layer B — Plan-mode gate (per-run toggle)

Ported from Pi `plan-mode/utils.ts`. When `RunState.planMode === true`, only allowlist-matching tools pass. Allowlist: Read, Grep, Glob, LSP, git status/diff/log, ls, cat-equivalents. Planner runs plan-mode-on by default; `/plan-build-review-fix` drops it entering `build`.

### 6.3 Layer C — Destructive-op approval tokens (default-deny for anything that modifies state)

**Rule: nothing destructive runs without a Judge-signed approval token.** Non-destructive reads run freely. Layer A items can never be approved.

Every Bash command and every Write/Edit tool call is classified by the `SafetyGuard.classify()` function:

**Safe (allowed, no approval)** — strictly an allowlist of read-only commands:
- Readers: `cat`, `bat`, `less`, `more`, `head`, `tail`, `wc`, `file`, `stat`, `xxd`, `od`
- Searchers: `grep`, `rg`, `ag`, `find` (without `-delete`/`-exec rm`), `fd` (without `-x rm`), `ls`, `la`, `ll`, `tree`
- Text processing to stdout: `awk` (without `-i inplace`), `sed` (without `-i`), `sort`, `uniq`, `cut`, `tr`, `jq`, `yq`, `diff`, `comm`
- System info: `pwd`, `whoami`, `hostname`, `uname`, `date`, `env` (read), `printenv`, `which`, `type`, `command -v`, `ps`, `top` (snapshot), `df`, `du`
- Git read-only: `git status`, `git diff`, `git log`, `git show`, `git blame`, `git branch` (list), `git tag` (list), `git rev-parse`, `git remote -v`, `git config --get`, `git ls-files`
- Build-system read: `make -n`, `npm view`, `npm ls`, `pnpm list`, `cargo tree`
- LSP / language readers: language servers, `tsc --noEmit`, `eslint --no-fix`, `pyright`, `mypy`
- Tests when invoked read-only: `npm test`, `pnpm test`, `vitest run`, `pytest`, `go test`, `cargo test` — tests are classified as safe because they should not have system side-effects; tests that touch the filesystem outside tmp are a bug, not a safety-guard concern
- Redirection to files inside project cwd and under `./tmp/`, `./.pi/engteam/runs/` — allowed without approval only when target is a new file or a file the current run created (checked via artifact registry)

**Destructive (requires approval token)** — default for anything not on the safe list, including but not limited to:
- File mutation: `rm`, `rmdir`, `mv`, `cp` (to existing target), `ln`, `unlink`, `touch` (on existing), `chmod` (non-system paths), `truncate`, `>` / `>>` redirect to files outside cwd or not run-owned
- In-place text edits: `sed -i`, `awk -i inplace`, `perl -i`
- Package managers: `npm install`, `npm uninstall`, `npm update`, `pnpm add`, `pnpm remove`, `yarn add`, `pip install`, `uv add`, `cargo add`, `go get`, `brew install`, `brew uninstall`
- Git mutators: `git push`, `git commit`, `git merge`, `git rebase`, `git cherry-pick`, `git reset` (any), `git checkout -- *`, `git clean`, `git branch -D`, `git tag -d`, `git stash drop`, `git worktree remove`
- Migrations / db: `drizzle-kit push`, `prisma migrate`, `alembic upgrade/downgrade`, `knex migrate`, any `psql`/`sqlite3`/`mysql` with write SQL
- Processes: `kill`, `pkill`, `killall`
- Containers: `docker rm`, `docker rmi`, `docker volume rm`, `docker-compose down -v`
- Build cleaners: `make clean`, `cargo clean`, `rm -rf node_modules`, `rm -rf dist`, `rm -rf target`
- External mutating HTTP: `curl -X POST/PUT/DELETE/PATCH` to non-localhost, `gh api --method POST/PUT/DELETE`, `gh pr create/edit/close`, `gh issue create/edit/close`
- Write/Edit tool calls: every non-read tool invocation
- Anything the classifier cannot positively identify as safe (default-deny)

**Compound commands:** pipes, `&&`, `||`, `;`, subshells `$(...)`, backticks, command substitution — the classifier parses the full command line via a shell AST (using `shell-quote` or similar) and requires every stage to be safe. One destructive stage anywhere → whole command is destructive.

**Approval flow** (same as before, reaffirmed):
1. Teammate calls `RequestApproval({op, command, args, justification})` → written to `.pi/engteam/runs/{runId}/approvals/pending/{reqId}.json`, Judge woken via `SendMessage`
2. Judge reviews against RunState + current artifacts + plan, calls `GrantApproval({requestId, ttlSeconds: 300, scope: "once" | "run-lifetime"})` → generates `{tokenId, runId, op, argsHash: sha256(normalizedCommand), scope, expiresAt, signature: hmac(runSecret, tokenId+op+argsHash+expiresAt+scope)}`
3. Token written to `.pi/engteam/runs/{runId}/approvals/{tokenId}.json`; per-run HMAC secret in `.pi/engteam/runs/{runId}/.secret` (0600)
4. SafetyGuard intercepts the tool call: classifies → destructive → computes argsHash from the normalized invocation, loads matching token, verifies signature + expiresAt + argsHash + scope, allows once (or for run-lifetime if scope allows)
5. Token marked `consumed: true` on use (or count-incremented for run-lifetime); all tokens revoked on run abort
6. Denied / unapproved destructive commands return `{block: true, reason: "destructive command requires Judge approval", layer: "C", classifierRule: "..."}` with the classifier's reasoning attached

**Judge authority bounds:** Judge can approve Layer C operations but cannot approve Layer A. The classifier checks Layer A first; if a command hits a Layer A rule, `RequestApproval` returns an error and the Judge cannot issue a token for it.

**Per-workflow policy:** workflows declare an `allowedOps` list to pre-authorize specific destructive patterns without per-call Judge approval. Example: `/migration` workflow can pre-authorize `drizzle-kit push` against a specific connection string; the Judge reviews the policy at run start rather than per-command. Policies are still signed and argsHash-verified.

---

## 7. Observer

### 7.1 Event schema

```ts
type Event = {
  ts: string;                            // ISO-8601
  runId: string;
  step?: string;
  iteration?: number;
  agentId?: string;                      // session id
  agentName?: string;
  category: "lifecycle" | "tool_call" | "tool_result" | "message"
          | "verdict" | "budget" | "safety" | "approval" | "error";
  type: string;                          // sub-type, e.g. "tool_call.start"
  payload: Record<string, unknown>;
  rawArgsRef?: string;                   // pointer into raw-args.jsonl when payload is digested
  summary?: string;
};
```

### 7.2 Storage

- Primary: `.pi/engteam/runs/{runId}/events.jsonl` (line-delimited JSON, fsync-batched every 100ms or 50 events)
- Raw args sidecar: `.pi/engteam/runs/{runId}/raw-args.jsonl` (referenced by `rawArgsRef`)
- Rotation: at 50MB → `events.jsonl` → `events.1.jsonl`, `events.2.jsonl`, ...
- Index: `.pi/engteam/runs/{runId}/events.index.json` — last-offset-per-category for tail queries

### 7.3 Event sources

All wire into a single `observer.emit(event)`:
- `pi.on("agent_start" | "agent_end")` → `lifecycle`
- `pi.on("tool_call" | "tool_result_end")` → `tool_call`, `tool_result`
- `pi.on("turn_end")` → `message` (summary)
- TeamRuntime `MessageBus.send` → `message` with `direction: "in"|"out"`
- ADW step transitions → `lifecycle` (`step.start`, `step.end`)
- SafetyGuard blocks → `safety`
- RequestApproval / GrantApproval / consume → `approval`
- 30s budget tick → `budget`
- VerdictEmit tool calls → `verdict`

### 7.4 Bundled server

Optional companion package `@sartoris/pi-engteam-server`:
- Node + Fastify + `better-sqlite3`
- Schema designed to be Postgres-portable (no SQLite-specific types; text JSON columns; schema migrations via `drizzle`)
- Tables: `runs`, `events`, `verdicts`, `approvals`, `messages`, `artifacts`
- Ingestion: tail `.pi/engteam/runs/*/events.jsonl` (chokidar watch) OR HTTP POST to `/events` (ndjson)
- Queries: REST + server-sent events for live dashboard
- Dashboard: minimal single-page HTML at `/`; swimlane view per run, event filter, verdict history

Extension-side integration: if `PI_ENGTEAM_EVENT_URL` is set (default on local install: `http://localhost:4747/events`), observer POSTs events in batches of 10 or every 2s. Failures queue to `events.sink-queue.jsonl` for retry.

### 7.5 Replay

```
pi-engteam replay <runId>
pi-engteam replay <runId> --from=verdict --step=build
pi-engteam replay <runId> --summarize    # dispatches to observability-archivist
```

---

## 8. Per-agent model routing

### 8.1 Defaults

Set in each agent's markdown frontmatter:
```md
---
name: judge
description: ...
model: claude-opus-4-6
tools: [SendMessage, VerdictEmit, GrantApproval, TaskList, ...]
---
```

### 8.2 Overrides

`~/.pi/engteam/model-routing.json`:
```json
{
  "overrides": {
    "implementer": "claude-sonnet-4-6",
    "bug-triage": "claude-haiku-4-5-20251001"
  },
  "budgetDownshift": {
    "enabled": true,
    "triggerAtPercent": 75,
    "rules": {
      "opus": "sonnet",
      "sonnet": "haiku"
    },
    "protected": ["judge", "architect"]
  }
}
```

When Judge enters a budget-extension review, it can invoke `adjustRouting({agentName, model})` to downshift a specific teammate for remaining steps. Protected agents never downshift automatically.

---

## 9. Slash commands

Registered via `pi.registerCommand`:

| Command | Purpose |
|---|---|
| `/engteam-install` | Stage-2 install: copy agents/prompts/skills, init `~/.pi/engteam/`, install server deps, run SQLite migrations |
| `/engteam-uninstall` | Reverse install; prompts before deleting `runs/` |
| `/engteam-doctor` | Health check: agent discovery, symlinks, server reachability, model routing validity |
| `/team-start` | Boot TeamRuntime, spawn all 14 agents idle |
| `/team-stop` | Graceful shutdown of all teammates |
| `/run-start <workflow> "<goal>"` | Create RunState, dispatch to ADW Engine |
| `/run-resume <runId>` | Resume paused/interrupted run |
| `/run-abort <runId>` | Revoke tokens, shutdown, finalize |
| `/run-status <runId>` | Print current step, iteration, budget, last verdict |
| `/plan-build-review` | Shortcut: `/run-start plan-build-review` |
| `/plan-build-review-fix` | Shortcut: the full fix-loop workflow |
| `/investigate "<question>"` | Investigation workflow |
| `/triage "<bug>"` | Triage workflow |
| `/verify "<spec>"` | Verification workflow |
| `/debug "<symptom>"` | Debug workflow |
| `/fix-loop <runId>` | Resume into fix step only |
| `/migration "<desc>"` | Migration workflow |
| `/refactor-campaign "<scope>"` | Refactor campaign workflow |
| `/doc-backfill "<target>"` | Doc backfill workflow |
| `/engteam-server start\|stop\|status` | Control the bundled observability server |

---

## 10. Distribution & install

### 10.1 Package layout

```
pi-engteam/
├── package.json                         # @sartoris/pi-engteam
├── tsconfig.json
├── install.sh                           # stage-1 bootstrap
├── src/
│   ├── index.ts                         # extension entry
│   ├── team/
│   │   ├── TeamRuntime.ts
│   │   ├── MessageBus.ts
│   │   └── tools/
│   │       ├── SendMessage.ts
│   │       ├── TaskList.ts
│   │       ├── VerdictEmit.ts
│   │       ├── RequestApproval.ts
│   │       └── GrantApproval.ts
│   ├── safety/
│   │   ├── SafetyGuard.ts
│   │   ├── patterns.ts
│   │   └── PlanMode.ts
│   ├── observer/
│   │   ├── Observer.ts
│   │   └── schema.ts
│   ├── adw/
│   │   ├── ADWEngine.ts
│   │   ├── RunState.ts
│   │   └── BudgetGuard.ts
│   ├── workflows/
│   │   ├── plan-build-review.ts
│   │   ├── plan-build-review-fix.ts
│   │   ├── investigate.ts
│   │   ├── triage.ts
│   │   ├── verify.ts
│   │   ├── debug.ts
│   │   ├── fix-loop.ts
│   │   ├── migration.ts
│   │   ├── refactor-campaign.ts
│   │   └── doc-backfill.ts
│   └── commands/                        # one file per slash command
├── agents/                              # 14 md files
│   ├── planner.md
│   ├── architect.md
│   ├── codebase-cartographer.md
│   ├── implementer.md
│   ├── reviewer.md
│   ├── tester.md
│   ├── security-auditor.md
│   ├── performance-analyst.md
│   ├── bug-triage.md
│   ├── incident-investigator.md
│   ├── root-cause-debugger.md
│   ├── judge.md
│   ├── knowledge-retriever.md
│   └── observability-archivist.md
├── prompts/                             # shared prompt fragments
├── skills/
│   ├── engteam-conventions.md
│   ├── safe-autonomy.md
│   └── team-comms.md
├── server/                              # bundled observability server
│   ├── package.json                     # @sartoris/pi-engteam-server
│   ├── src/
│   │   ├── index.ts
│   │   ├── db/
│   │   │   ├── schema.ts                # drizzle schema, Postgres-portable
│   │   │   └── migrations/
│   │   ├── ingest.ts
│   │   ├── api.ts
│   │   └── dashboard/                   # single-page HTML
│   └── README.md
├── scripts/
│   ├── install-stage2.ts                # invoked by /engteam-install
│   └── uninstall.ts
└── dist/                                # tsup build output
```

### 10.2 Install flow

**Stage 1 — Shell bootstrap (one-time, from GitHub):**
```sh
git clone https://github.com/sartoris/pi-engteam.git
cd pi-engteam
./install.sh
```

`install.sh` does:
1. Verify Pi is installed (`which pi` or `~/.pi/agent/` exists)
2. Verify Node ≥20 and pnpm are available
3. `pnpm install && pnpm build`
4. Copy `dist/` + `src/commands/` to `~/.pi/agent/extensions/pi-engteam/` (overwrite if exists)
5. Write `~/.pi/agent/config.d/pi-engteam.json` registering the extension path
6. Print next step: "Launch Pi and run /engteam-install to finish setup"

**Stage 2 — Pi slash command `/engteam-install`:**
Invokes `scripts/install-stage2.ts` which:
1. Copy `agents/*.md` → `~/.pi/agent/agents/engteam-*.md` (namespaced to avoid collisions)
2. Copy `prompts/*.md` → `~/.pi/agent/prompts/engteam/`
3. Copy `skills/*.md` → `~/.pi/agent/skills/engteam/`
4. Create `~/.pi/engteam/{runs,workflows,approvals,server}/` with 0700 perms
5. Copy default `~/.pi/engteam/safety.json`, `model-routing.json`, `server.json`
6. If user opts in (prompt): `cd server && pnpm install`, run drizzle migrations on `~/.pi/engteam/server/engteam.sqlite`
7. Print: "Installed. Run /team-start to boot the team, or /engteam-server start for the dashboard."

**Per-project install (optional):**
```sh
pnpm pi-engteam init --project
```
Copies a minimal `.pi/extensions/pi-engteam/` into the current repo so the team ships with it.

### 10.3 Uninstall

`/engteam-uninstall` removes `~/.pi/agent/extensions/pi-engteam/`, the `~/.pi/agent/agents/engteam-*.md` files, prompts/skills, and `~/.pi/agent/config.d/pi-engteam.json`. Prompts before deleting `~/.pi/engteam/runs/` (user data).

### 10.4 Version compatibility

`package.json` declares `peerDependencies: { "@mariozechner/pi-coding-agent": ">=X.Y.Z <N+1" }` and install.sh checks `pi --version` against the range. Mismatch → fail with clear remediation message.

---

## 11. Testing strategy

### 11.1 Unit (vitest)
- `safety/patterns.test.ts` — every rm/env/push pattern; `.env.sample` allow-case; plan-mode allowlist
- `adw/stepMachine.test.ts` — all 10 workflow transitions; budget exhaustion halts correctly; resume produces same terminal state
- `adw/verdict.test.ts` — VerdictEmit round-trip; malformed verdicts rejected
- `team/router.test.ts` — MessageBus delivery (name, `*`, idle-wake); FIFO preserved per-recipient
- `observer/events.test.ts` — jsonl round-trip, rotation at 50MB, HTTP sink retry on 5xx, queue drain

### 11.2 Integration (vitest + real `pi` binary; guarded by `PI_BIN` env var)
- `team-runtime.integration.test.ts` — spawn Planner + Implementer, send message, assert delivery <50ms, both reach idle
- `safety-guard.integration.test.ts` — session attempts `rm -rf /tmp/test`, assert block + event logged
- `adw-fix-loop.integration.test.ts` — `/plan-build-review-fix` on a fixture repo with a known-broken test; assert PASS within 3 iterations
- `install.integration.test.ts` — run `install.sh` + stage-2 against sandboxed `HOME`, assert all files in correct locations, idempotent on second run

### 11.3 Smoke (CI)
Build, install into ephemeral Pi home, run `/team-start`, spawn Planner, send "hello", assert response, teardown. Runs on every PR.

### 11.4 Evals (longer-cycle, non-gating)
- 10 fixture bugs → `/debug` → success rate + cost per bug
- 10 fixture features → `/plan-build-review-fix` → PASS rate + iterations + cost
- Results tracked in `evals/results/{date}.json`; regressions block release

---

## 12. Config files

### `~/.pi/engteam/safety.json`
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
  "exemptPaths": ["./tmp/**", "./.pi/engteam/runs/**"],
  "tokenTtlSeconds": 300,
  "allowRunLifetimeScope": true
}
```

`hardBlockers.alwaysOn` and `classification.mode: "default-deny"` cannot be changed by workflow policies — they are enforced at extension load. Users can extend the safe allowlist (e.g., adding a project-specific safe read command) or move a safe command to destructive, but cannot weaken default-deny.

### `~/.pi/engteam/model-routing.json`
See §8.2.

### `~/.pi/engteam/server.json`
```json
{
  "enabled": false,
  "port": 4747,
  "db": { "path": "~/.pi/engteam/server/engteam.sqlite" },
  "ingestion": {
    "mode": "http",
    "modeOptions": "http | watch | both",
    "watchPaths": ["~/.pi/engteam/runs/*/events.jsonl"]
  }
}
```

---

## 13. Observability event categories (quick reference)

| Category | Types |
|---|---|
| `lifecycle` | `run.start`, `run.end`, `step.start`, `step.end`, `agent.start`, `agent.end`, `team.boot`, `team.shutdown` |
| `tool_call` | `start`, `end` |
| `tool_result` | `ok`, `error` |
| `message` | `sent`, `received`, `broadcast` |
| `verdict` | `emit` |
| `budget` | `tick`, `warn_75`, `warn_90`, `exhausted`, `extended` |
| `safety` | `block`, `warn`, `plan_mode_on`, `plan_mode_off` |
| `approval` | `request`, `grant`, `consume`, `revoke`, `expired` |
| `error` | `uncaught`, `agent_crash`, `router_drop`, `sink_failure` |

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Runaway cost from autonomy | Budget guardrails with Judge-extendable limits; default `maxCostUsd: 20`, `maxIterations: 8` |
| Judge self-approves unsafe ops | `approvalAuthority: "judge"` is V1 only; V2 adds human-or-both; hard blockers (Layer A) always override |
| Message bus deadlock (A waits on B waits on A) | Router timeout per message (default 300s); budget guard surfaces stuck runs at 90% wall time |
| Verdict parsing ambiguity | `VerdictEmit` structured tool is the only verdict source; free-text verdicts in messages are ignored |
| Stale state on crash | state.json atomically rewritten; resume reconstructs teammate sessions from transcripts |
| Extension breaks on Pi upgrade | `peerDependencies` version range + `/engteam-doctor` health check on startup |
| Agent .md namespace collision with user agents | `engteam-` prefix on all installed agent files |

---

## 15. Open questions (tracked, not blocking)

None at spec-approval time. Deferred to implementation-plan phase.
