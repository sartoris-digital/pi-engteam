---
title: pi-engineering Evolution — Architectural Vision
date: 2026-05-06
status: approved
---

# pi-engineering Evolution — Architectural Vision

## 1. Overview

This spec defines an architectural evolution of pi-engteam that adds five capabilities, layered on top of the existing extension without breaking current workflows:

1. **Lead-agent hierarchy (regroup-in-place).** A new Orchestrator and four Lead agents sit between the user and the existing 16 workers. Old workflows continue calling workers directly. New workflows route through Leads. No big-bang restructure.
2. **Verifier loop.** Every worker step in opt-in workflows is followed by an independent read-only verifier that atomizes claims, runs deterministic checks, and demands corrective re-iteration on failure. Bounded by per-run round budget.
3. **Learner agent (verifier self-improvement).** A privileged on-demand agent that reads verifier gap logs, authors and tests new verifier scripts, and submits proposed upgrades for Judge approval. Verifier accuracy compounds over time without manual scripting.
4. **Autopilot improvements.** Workflow-defined rounds, named run phases, graceful cancel vs. nuclear rollback.
5. **Secrets vault.** Encrypted SQLite + OS-keyring master key. Agent-facing as a `UseSecret(name, target)` tool plus MCP/skill manifest declarations. Plaintext never enters prompts, conversation logs, events, or session JSONL. A pre-context watcher catches accidental key pastes and auto-vaults them.

A sixth piece connects them: a new `consult` workflow (war-room semantics in the TUI, no UI surface) where the Orchestrator fans out a topic to multiple Leads in parallel, each Lead provides their specialty take and adversarial review of peers' takes, and the Orchestrator synthesizes back to the user.

The evolution is shaped by three reference systems:

- **lead-agents (Multi-Team Chat)** — depth-2 delegation, mental models that compound, domain locking, configuration-driven teams, conversation awareness.
- **the-verifier-agent-system** — two-agent observer pattern, read-only by architecture, structured rejection contracts, "the error message is the documentation," verification accuracy compounds.
- **claudex (Codex Loop)** — autopilot loops with round budgets, named phases, graceful cancel and nuclear rollback semantics, state-machine transitions.

## 2. Out of Scope

Explicit non-goals for this spec:

- **Web war-room UI.** Deferred indefinitely. War-room semantics are achieved via the `consult` workflow in Pi's TUI.
- **Voice routing, video meet integrations, mobile/messaging bridges** (Telegram, Slack, Discord). Pi CLI only.
- **Replacing existing workflows.** The 12 shipping workflows continue working untouched.
- **Globs in domain locking.** v1 supports literal directory roots only.
- **Stop-hook-style forced continuation.** Pi-engteam's ADWEngine already drives the loop server-side; Codex's Stop-hook primitive is unnecessary.
- **Cost-driven budget defaults.** Subscription-based usage shifts the constraint to rate limits (RPM/TPM/concurrent in-flight). Cost remains as an optional backstop, off by default.

## 3. Success Criteria

- All 12 existing workflows pass their existing test suites unchanged.
- New `/consult <topic>` workflow runs Engineering + Validation + Investigation Leads in parallel, produces a synthesis, and writes per-Lead position files.
- Verifier catches a deliberately-broken implementer claim (e.g., "I added the FK" without actually running the migration) on at least one fixture, posts a corrective message, and the implementer iterates to PASS within `max_verify_loops`.
- A user can run `/secret-set OPENAI_API_KEY <value>`, then run an MCP that consumes it, with zero plaintext appearing in `events.jsonl`, `conversation.jsonl`, agent prompts, or session JSONL.
- A user pasting an obvious key shape (e.g., `sk-ant-...`) into the Pi prompt is intercepted before the message reaches any agent's context, prompted to vault under a suggested name, and the rewritten message contains a `${SECRET:NAME}` placeholder.
- A worker attempting to write outside its declared domain receives a structured block message with allowed paths.
- After a run produces a verifier `PARTIAL` verdict, `/learn` dispatches the Learner; the Learner authors a staged script + fixture; Judge approves; the next equivalent run produces a verifier `PASS`.

---

## 4. Agent Topology

### 4.1 Roster

```
                          ┌─────────────────────┐
                          │     Orchestrator    │  (new, Opus)
                          │  classifies, routes │
                          │  parallel by default│
                          └──────────┬──────────┘
                                     │
        ┌────────────────┬───────────┼───────────┬────────────────┐
        ▼                ▼           ▼           ▼                ▼
  ┌─────────┐      ┌─────────┐  ┌─────────┐  ┌─────────┐    ┌─────────┐
  │Planning │      │ Eng     │  │ Valid.  │  │ Invest. │    │  Judge  │
  │  Lead   │      │  Lead   │  │  Lead   │  │  Lead   │    │ (xfn)   │
  │ (Opus)  │      │ (Opus)  │  │ (Opus)  │  │ (Opus)  │    │ (Opus)  │
  └────┬────┘      └────┬────┘  └────┬────┘  └────┬────┘    └─────────┘
       │                │            │            │              ▲
       ▼                ▼            ▼            ▼      grants approval
  workers           workers       workers       workers     tokens only
                                                                ▲
                                                                │
                  ┌─────────────────────────┐                   │
                  │  Verifier (read-only,   │                   │
                  │  per-run, observer)     │                   │
                  └────────────┬────────────┘                   │
                               │ reads gaps                     │
                               ▼                                │
                  ┌─────────────────────────┐                   │
                  │  Learner (on-demand,    │ requests script   │
                  │  authors verifier-      │ updates ──────────┘
                  │  script upgrades)       │
                  └─────────────────────────┘
```

### 4.2 Team membership

| Team | Lead | Workers |
|---|---|---|
| Planning | `planning-lead` | `planner`, `architect`, `discoverer`, `codebase-cartographer`, `knowledge-retriever` |
| Engineering | `engineering-lead` | `implementer`, `root-cause-debugger`, `performance-analyst` |
| Validation | `validation-lead` | `reviewer`, `tester`, `security-auditor` |
| Investigation | `investigation-lead` | `incident-investigator`, `bug-triage`, `observability-archivist`, `issue-analyst` |

### 4.3 New agent definitions

Six new agents added by this evolution:

| Agent | Model | Spawn | Role |
|---|---|---|---|
| `orchestrator` | Opus | At `/team-start` | Classifies user requests, decomposes into team-shaped tasks via TillDone, dispatches to one or more Leads (parallel by default), synthesizes responses, reads `<run>/conversation.jsonl`. Owns no domain. Backfills `team` field on unassigned tasks. |
| `planning-lead` | Opus | At `/team-start` | Coordinates Planning workers. Writes team mental model. Synthesizes worker outputs into a single team position. Does not execute — delegates only. |
| `engineering-lead` | Opus | At `/team-start` | Coordinates Engineering workers. Same shape as Planning Lead. |
| `validation-lead` | Opus | At `/team-start` | Coordinates Validation workers. Same shape. |
| `investigation-lead` | Opus | At `/team-start` | Coordinates Investigation workers. Same shape. |
| `verifier` | Sonnet | Per run, by ADWEngine | Read-only observer of worker steps. Atomizes claims, runs deterministic verifier scripts, posts corrective `SendMessage` envelopes back to the worker on FAIL. |
| `learner` | Opus | On demand (`/learn`) | Reads verifier gap logs, authors and tests new verifier scripts, submits proposed upgrades for Judge approval. Privileged write to a staging dir only. |

### 4.4 Existing 16 agents (unchanged)

The 15 team workers plus the cross-team `judge` continue with their current function, prompt, and tool access. They gain a `team:` field in their frontmatter (the `judge` is marked `team: cross-functional` since it serves all teams) and inherit team policy from `teams.yaml`. Old workflows continue dispatching to them directly via the existing `team-start` boot flow.

`judge` retains its current cross-team approval authority — the only agent that can grant HMAC-signed approval tokens. It reports into the Orchestrator in the new topology rather than into any single Lead.

### 4.5 Topology invariants

- **Leads never execute.** Their tools are limited to `SendMessage`, `TaskUpdate`, `VerdictEmit`, `Read` (for synthesis). No `Write`, `Edit`, `Bash`. Domain locks enforce this in addition to the tool allowlist.
- **Workers never delegate to peers.** Workers can only `SendMessage` upward to their Lead or to the Orchestrator. No worker-to-worker messaging.
- **Orchestrator never delegates to workers directly.** Always goes through a Lead. Forces depth-2 boundary.
- **Verifier is read-only by architecture.** Persona `tools:` allowlist excludes `Write`/`Edit`. `bash_policy: script-only` blocks any bash that doesn't match the verifier-script runner. Verifier scripts themselves enforce read-only at the OS layer (e.g., SQLite `mode=ro`).
- **Learner cannot promote its own changes.** Promotion from `.staging/` to active scripts requires HMAC-signed Judge approval token.

### 4.6 Boot flow

`/team-start` sequence:

1. Spawn 5 new lead-tier sessions: Orchestrator + 4 Leads.
2. Spawn 16 existing sessions (15 team workers + `judge`) — current behavior.
3. Workers learn their team membership from frontmatter; Leads learn their roster from `teams.yaml`.
4. Verifier and Learner are **not** spawned at boot. Verifier is spawned by ADWEngine the first time a run encounters a verified step, then reused for the remainder of that run's lifetime. Learner is spawned on demand by `/learn` and disposed when its workflow completes.

Total session count at boot: **21** (was 16). Per-run during a verified workflow: **+1** verifier (22 in flight). During a learning run: **+1** learner.

---

## 5. Workflow Evolution

Three changes. Existing 12 workflows untouched.

### 5.1 New `consult` workflow

Cross-team adversarial review pattern in Pi's TUI. New shortcut: `/consult <topic> [teams=eng,valid,invest]`.

Steps with parallel-default DAG:

| # | Phase | Behavior |
|---|---|---|
| 1 | `dispatch` | Orchestrator parses topic, selects teams (default: all four if not specified), creates TillDone tasks per team, fans out to selected Leads in parallel. |
| 2 | `position` | Each Lead reads topic + `<run>/conversation.jsonl`, optionally consults its workers, writes `<run>/positions/<lead>.md` with team's specialty take. Parallel across Leads. Lead emits `VerdictEmit { step: "position", verdict: PASS, artifacts: ["<path>"] }`. |
| 3 | `adversarial` | Each Lead reads peers' position files and writes `<run>/adversarial/<lead>.md` — explicit pushback, risks, blind spots. Parallel across Leads. |
| 4 | `synthesis` | Orchestrator reads all positions + adversarials, writes `<run>/synthesis.md` with: areas of agreement, contested points, recommended path forward, deferred decisions. Returns synthesis to user. |

**Round budget:** default 1 round (= positions + adversarials + synthesis). User can request `--rounds 2` for deeper deliberation; Round 2 lets each Lead revise its position in light of Round 1's adversarials.

**Termination:** PASS at synthesis. No loop unless `--rounds N > 1`. The verifier does not run on consult workflows — there's nothing to deterministically verify in opinion deliberations.

Example workflow declaration:

```typescript
const consult: Workflow = {
  id: "consult",
  steps: [
    { name: "dispatch", agent: "orchestrator" },
    { name: "position-eng",    agent: "engineering-lead",    dependsOn: ["dispatch"] },
    { name: "position-valid",  agent: "validation-lead",     dependsOn: ["dispatch"] },
    { name: "position-invest", agent: "investigation-lead",  dependsOn: ["dispatch"] },
    { name: "adversarial-eng",    agent: "engineering-lead",
      dependsOn: ["position-eng", "position-valid", "position-invest"] },
    { name: "adversarial-valid",  agent: "validation-lead",
      dependsOn: ["position-eng", "position-valid", "position-invest"] },
    { name: "adversarial-invest", agent: "investigation-lead",
      dependsOn: ["position-eng", "position-valid", "position-invest"] },
    { name: "synthesis", agent: "orchestrator",
      dependsOn: ["adversarial-eng", "adversarial-valid", "adversarial-invest"] },
  ]
};
```

### 5.2 Verifier integration into existing workflows

Trigger point: every `VerdictEmit` from a worker step in a workflow that declares `verify: true` in its step config.

Defaults:

| Workflow | Steps that auto-verify |
|---|---|
| `plan-build-review` | `build` |
| `plan-build-review-fix` | `build`, `fix` |
| `migration` | `implement` |
| `fix-loop` | `fix` |
| `refactor-campaign` | `implement` |
| All others | none (off by default; opt-in per step) |

Verification flow per verified step:

```
Worker emits VerdictEmit { step: "build", verdict: PASS, artifacts: [...] }
  │
  ▼
ADWEngine pauses step transition.
  - On the run's first verified step: spawn Verifier session, scoped to run lifetime.
  - On subsequent verified steps: dispatch a new prompt to the existing Verifier session.
ADWEngine sends the Verifier:
  - runId, stepName, worker session JSONL slice (line offsets)
  - artifacts list (worker's claims)
  - allowed verifier scripts at ~/.pi/engineering-team/verifier-scripts/
  │
  ▼
Verifier atomizes claims from session JSONL + artifacts
  Each claim mapped to a verification script invocation
  Scripts run via SafetyGuard with bash_policy: script-only
  │
  ▼
Verifier emits VerdictEmit {
  step: "verify:build",
  verdict: PASS|FAIL|PARTIAL,
  issues: [...],
  artifacts: ["verify-report.md"]
}
  │
  ├─ PASS    → ADWEngine continues to next workflow step
  ├─ PARTIAL → ADWEngine continues; appends gaps to <run>/learning/gaps.jsonl;
  │            logs in run state for /learn consumption
  └─ FAIL    → ADWEngine sends corrective SendMessage to original worker
              (verifier's issues[] becomes the message body)
            Worker re-runs the step; verifier re-checks
            Bounded by max_verify_loops (default 3)
            On loop exhaustion: surface escalation, run pauses for user
```

Worker doesn't know the verifier exists. It receives the corrective message as a normal `SendMessage` from the system. (Opt-out: a workflow can declare `verify: false` per step to skip.)

**Verifier scripts** ship at `~/.pi/engineering-team/verifier-scripts/`:

- `verify_typescript.py` — `tsc --noEmit`, `eslint --check`, file-existence assertions on artifacts
- `verify_python.py` — same shape, ruff/mypy/pytest --collect-only
- `verify_sqlite.py` — schema integrity, FK checks, read-only DB connection
- `verify_generic.py` — file-existence + grep-pattern fallback

Authoring follows the verifier-agent-system pattern (PEP-723 inline-script header for Python, structured JSON rejections, `emit()` / `reject()` helpers).

### 5.3 Autopilot improvements

Three changes to RunState:

**Phases.** New field `phase: "active" | "cancelling" | "cancelled" | "rolled-back" | "done" | "failed"`. ADWEngine checks phase at every step boundary; `cancelling` transitions to `cancelled` cleanly at next boundary.

**Rounds.** New field `rounds: { current: 0, max: 3 }`. Workflows declare their own round shape; an iteration that completes one full round increments `current`. Exhaustion halts run with `failed`.

**Cancel/rollback commands:**

- `/run-cancel <runId>` — sets `phase: cancelling`, ADWEngine respects at next boundary, marks `cancelled`, preserves all run state for audit.
- `/run-rollback <runId>` — wipes `~/.pi/engineering-team/runs/<runId>/` *except* `cancelled.log` (debug record). Use when cancel didn't take.
- `/run-abort` — kept as alias for `/run-cancel` in v1, removed in next major.

---

## 6. Secrets Vault

### 6.1 Storage and crypto

**Backend.** Encrypted SQLite at `~/.pi/engineering-team/secrets.db`. Single table:

```sql
CREATE TABLE secrets (
  name           TEXT PRIMARY KEY,         -- e.g., 'OPENAI_API_KEY'
  value_enc      BLOB NOT NULL,            -- AES-256-GCM ciphertext
  iv             BLOB NOT NULL,            -- per-row IV
  tag            BLOB NOT NULL,            -- GCM auth tag
  created_at     INTEGER NOT NULL,         -- epoch ms
  last_used_at   INTEGER,                  -- epoch ms, null if never used
  use_count      INTEGER NOT NULL DEFAULT 0,
  notes          TEXT                       -- user-supplied label
);
```

**Master key.** 32-byte random key, generated once at vault initialization. Stored in OS keyring under service `pi-engineering` / account `secrets-master`. Loaded once at extension boot into a `Buffer` held in process memory; zeroed on extension teardown.

**Keyring fallback.** If keyring access fails (no libsecret, headless Linux, locked Keychain), prompt the user once at first secrets operation in the Pi session for a passphrase. Derive the master key via Argon2id (memory-hard KDF) using a salt stored at `~/.pi/engineering-team/secrets.salt`. Cache the derived key in memory until extension teardown.

**Crypto.** AES-256-GCM (Node's built-in `crypto`). Per-row random 12-byte IV. Auth tag verified on every read — tampering detected. No external crypto libraries.

### 6.2 CLI commands

```
/secret-set <NAME> [--note "..."]    prompts for value via secure stdin (no echo,
                                     not in shell history). Encrypts, stores.
/secret-list                         prints names + notes + last_used_at + use_count.
                                     NEVER prints values.
/secret-rm <NAME>                    removes a secret. Prompts for confirm.
/secret-rotate <NAME>                re-prompts for new value, replaces.
/secret-export                       writes a backup blob (encrypted with a user-
                                     supplied passphrase, distinct from the keyring
                                     master) to a file the user names. For migrations
                                     between machines.
/secret-import <path>                inverse of export.
/secret-scrub <NAME>                 retroactive scrubbing — see §6.4.
```

Stdin prompt for `/secret-set` reads via `tty` raw mode with echo off — not from the Pi user-message channel. The plaintext never enters the conversation log, observability stream, or session JSONL.

### 6.3 Agent-facing model

Two paths. Neither exposes plaintext to the LLM.

**Path 1 — `UseSecret` tool (for ad-hoc bash and one-off API calls).**

Workers and Leads receive a new tool:

| Param | Type | Description |
|---|---|---|
| `name` | string | Secret name, e.g., `OPENAI_API_KEY` |
| `target` | enum | `bash` \| `mcp:<name>` \| `skill:<name>` |
| `command` | string? | Required when `target=bash`. The shell command to run. May reference the secret as `$SECRET`. |
| `mcp_call` | object? | Required when `target=mcp`. Tool name + args. |
| `skill_id` | string? | Required when `target=skill`. |

Runtime behavior:

1. Agent calls `UseSecret({ name: "OPENAI_API_KEY", target: "bash", command: "curl -H 'Authorization: Bearer $SECRET' https://api.openai.com/..." })`.
2. SafetyGuard validates: secret exists, agent's domain allows the operation, classification rules pass.
3. Runtime fetches plaintext from the vault, sets it as env var `SECRET` *only* in the spawned subprocess, not the parent.
4. Subprocess executes; stdout/stderr/exit code returned to agent.
5. Vault updates `last_used_at` and `use_count`.
6. Observability event emitted: `safety:secret_access { agent, secret_name, target, timestamp }` — no value.

**Critically:** the `command` string in the agent's tool call contains `$SECRET`, not the value. The agent never sees plaintext. Even the substituted command line is not logged to events.jsonl — only the pre-substitution form.

**Path 2 — MCP/skill manifest declaration (for tools that always need the same secrets).**

MCPs and skills declare required secrets in their manifest:

```yaml
# example: my-openai-mcp/manifest.yaml
name: openai-mcp
secrets:
  - name: OPENAI_API_KEY
    env_var: OPENAI_API_KEY
    required: true
  - name: OPENAI_ORG_ID
    env_var: OPENAI_ORG_ID
    required: false
```

When an agent invokes the MCP/skill, the runtime spawns it with the declared secrets injected into its environment. The agent doesn't reference the secret at all — it just calls the MCP tool. The runtime resolves and injects.

Manifest schema validation at registration time: missing required secrets produce a structured error before the MCP/skill becomes available to agents.

### 6.4 Secret watcher and auto-vaulting

A SafetyGuard component intercepts every user message *before* it reaches any agent's context, scans for known-shape secret patterns, and quarantines them.

**Detection rules (v1, high-precision known-prefix patterns):**

| Pattern | Suggested name |
|---|---|
| `sk-ant-[A-Za-z0-9_-]{20,}` | `ANTHROPIC_API_KEY` |
| `sk-[A-Za-z0-9]{40,}` | `OPENAI_API_KEY` |
| `sk-proj-[A-Za-z0-9_-]{40,}` | `OPENAI_API_KEY` |
| `ghp_[A-Za-z0-9]{36}` | `GITHUB_TOKEN` |
| `gho_[A-Za-z0-9]{36}` | `GITHUB_OAUTH_TOKEN` |
| `github_pat_[A-Za-z0-9_]{82}` | `GITHUB_PAT` |
| `xox[bp]-\d+-\d+-[A-Za-z0-9]+` | `SLACK_TOKEN` |
| `AKIA[0-9A-Z]{16}` | `AWS_ACCESS_KEY_ID` |
| `aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}` | `AWS_SECRET_ACCESS_KEY` |
| `eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}` | `JWT_TOKEN` |
| Custom user-defined patterns in `~/.pi/engineering-team/secret-patterns.json` | user-named |

High-precision only by default. An optional `--strict-secrets` flag enables an entropy heuristic that flags any 32+ char string with Shannon entropy > 4.5 bits/char — off by default to avoid scrubbing legitimate hashes/fixtures.

**Detection flow:**

```
User submits message via Pi prompt
  │
  ▼
SafetyGuard secret watcher scans message text
  │
  ├─ No match → message proceeds unchanged
  │
  └─ Match found
        │
        ▼
   Pi TUI prompt overrides the message with a confirmation:
   "⚠ Possible secret detected: `sk-ant-abc...xyz` (truncated)
    Suggested name: ANTHROPIC_API_KEY
    [Enter] to vault under suggested name
    [edit name] to vault under custom name
    [skip] to send as-is (false positive)"
        │
        ├─ Vault: store in secrets.db (rotate if name exists),
        │         replace value in original message with `${SECRET:NAME}`,
        │         then send the rewritten message to the agent
        │
        └─ Skip: send original message, log a `safety:secret_skip` event
                 with truncated preview only
```

Pre-context interception is the primary defense. The watcher runs *before* the message is dispatched to the MessageBus, so the agent never sees the original.

**Retroactive scrubbing — defense-in-depth.** If the watcher misses a leak, `/secret-scrub <NAME>` triggers after-the-fact cleanup:

1. Vault the secret under `<NAME>` (prompt for value via secure stdin).
2. Backup current run dir to `<run>/.pre-scrub-backup/`.
3. Walk every file in `<run>/`, every per-agent session JSONL touched by this run, and `~/.pi/engineering-team/second-brain/logs/<today>.md`.
4. Replace exact byte matches of the value with `[REDACTED:<NAME>]`.
5. Emit `safety:secret_scrub { name, files_modified, bytes_replaced }` event.
6. Inject a system notice into each affected agent's next turn: `"A secret in your prior context has been redacted and moved to the vault. Reference it as ${SECRET:<NAME>} going forward."`

Limitation flagged honestly: retroactive scrubbing cleans on-disk state, but the LLM's already-processed context cannot be reached — the model has *seen* the value once. Mitigation is to rotate the secret immediately (the user does this externally; we suggest it in the post-scrub message), at which point the leaked value is dead.

**Configuration extends `~/.pi/engineering-team/safety.json`:**

```json
{
  "secretWatcher": {
    "enabled": true,
    "strictMode": false,
    "interactivePrompt": true,
    "onSkipBehavior": "warn"
  }
}
```

### 6.5 Threat model

**Protects against:**
- Secrets leaking into LLM context windows (prompt, history, conversation.jsonl).
- Secrets appearing in observability events.
- Secrets being extracted by curious or malicious agent prompts.
- Plaintext secrets at rest on disk.
- Secrets surviving in shell history.
- Accidental key pastes via the Pi prompt.

**Does NOT protect against:**
- A user typing a secret into the prompt that doesn't match any pattern (false negative; mitigated by user awareness).
- Malicious MCPs/skills that legitimately receive a secret and exfiltrate it (manifest is trust boundary; pin and audit MCPs).
- Memory inspection on a compromised machine.
- Compromise of the OS keyring itself.

---

## 7. Domain Locking — SafetyGuard Layer D

### 7.1 Layer order

SafetyGuard gains a fourth layer. Order of evaluation (short-circuits on first deny):

```
Tool call from agent
  │
  ▼
[Layer A] Hard blockers       existing (rm -rf, sudo, force-push to main, .env writes)
  │ pass
  ▼
[Layer B] Plan-mode gate      existing (read-only when planMode=true)
  │ pass
  ▼
[Layer C] Default-deny class  existing (HMAC approval token required for destructive ops)
  │ pass
  ▼
[Layer D] Domain lock         NEW: agent's declared paths
  │ pass
  ▼
Operation proceeds
```

### 7.2 Domain semantics

Each agent has three sets of paths:

| Field | Meaning |
|---|---|
| `read` | Paths the agent may read via `Read`, `Grep`, `Glob`, `Bash` (with read-only verbs). |
| `upsert` | Paths the agent may create or modify via `Write`, `Edit`, `Bash` (with write redirects). Does NOT include delete. |
| `delete` | Paths the agent may delete. Almost always empty. |

**Path matching:** literal directory roots. A path `P` is allowed if `P` resolves *under* (or equal to) a declared root. Symlinks resolved before comparison. No globs in v1.

### 7.3 Three-layer config merge

Resolved at session start. Later layers override conflicts in earlier layers; declared paths *unioned* (not replaced) so a project can extend without rewriting.

**Layer 1 — built-in defaults** (shipped with extension, in `src/safety/default-domains.ts`):

```yaml
orchestrator:
  read: ["."]
  upsert: ["${RUN_DIR}/conversation.jsonl", "${RUN_DIR}/synthesis.md"]
  delete: []

planning-lead:
  read: ["."]
  upsert: ["${RUN_DIR}", "specs/", "${EXPERTISE_DIR}/planning.md"]
  delete: []

engineering-lead:
  read: ["."]
  upsert: ["${RUN_DIR}", "${EXPERTISE_DIR}/engineering.md"]
  delete: []

# (validation-lead, investigation-lead similar)

planner:
  read: ["."]
  upsert: ["${RUN_DIR}/plan.md", "${RUN_DIR}/notes/"]
  delete: []

implementer:
  read: ["."]
  upsert: ["src/", "tests/", "scripts/", "${RUN_DIR}/notes/"]
  delete: []

reviewer:
  read: ["."]
  upsert: ["${RUN_DIR}/review.md", "${RUN_DIR}/notes/"]
  delete: []

tester:
  read: ["."]
  upsert: ["tests/", "${RUN_DIR}/notes/"]
  delete: []

security-auditor:
  read: ["."]
  upsert: ["${RUN_DIR}/notes/"]
  delete: []

# ... (other workers follow team conventions)

verifier:
  read: ["."]
  upsert: ["${RUN_DIR}/verification/"]
  delete: []
  bash_policy:
    mode: "script-only"
    runner: "uv run --script"
    allowed_scripts: ["~/.pi/engineering-team/verifier-scripts/*.py"]

learner:
  read: ["."]
  upsert:
    - "~/.pi/engineering-team/verifier-scripts/.staging/"
    - "${RUN_DIR}/learning/"
  delete: []
  # No custom bash_policy — Learner uses the default Pi bash surface, gated by Layer C
  # default-deny. Read-only verbs are whitelisted; subprocesses that execute scripts under
  # the staging dir for fixture validation are explicitly classified as safe via the standard
  # SafetyGuard classifier.

judge:
  read: ["."]
  upsert: ["${RUN_DIR}/approvals/"]
  delete: []
```

`${RUN_DIR}` resolves to `~/.pi/engineering-team/runs/<runId>/` at session start. `${EXPERTISE_DIR}` resolves to `<cwd>/.pi/engineering-team/expertise/` for project-scoped, or `~/.pi/engineering-team/expertise/` for user-global. Both resolved.

**Layer 2 — user-global override** at `~/.pi/engineering-team/teams.yaml`. Optional. Merged with defaults.

**Layer 3 — project-local override** at `<cwd>/.pi/engineering-team/teams.local.yaml`. Optional. Gitignored by default. Merged on top.

**Merge rule:** for each agent, union the `read`/`upsert`/`delete` arrays across layers. Conflict on `bash_policy` resolves to most-restrictive wins.

### 7.4 Per-agent frontmatter

Each agent's markdown file gets a `domain:` block in YAML frontmatter. Team YAML can either fully replace or extend frontmatter values. Frontmatter is the source of truth if `teams.yaml` is missing.

```markdown
---
name: implementer
team: engineering
model: claude-sonnet-4-6
domain:
  read: ["."]
  upsert: ["src/", "tests/", "scripts/"]
  delete: []
---

You are the implementer. Your job is to write code...
```

### 7.5 Block messages

When SafetyGuard Layer D blocks an operation, the returned message is structured and educational, modeled on the verifier-agent-system pattern:

```json
{
  "block": true,
  "reason": "domain-lock",
  "agent": "implementer",
  "operation": "Write",
  "path": "infrastructure/terraform/main.tf",
  "allowed_paths": {
    "upsert": ["src/", "tests/", "scripts/", "/Users/.../runs/abc123/notes/"],
    "delete": []
  },
  "hint": "infrastructure/ is outside this agent's domain. To proceed, either: (a) ask the engineering-lead to delegate to an agent with infrastructure permissions, (b) add 'infrastructure/' to implementer.upsert in teams.local.yaml, or (c) request judge approval via RequestApproval to bypass for this run."
}
```

The agent reads the rejection and self-corrects on the next step. No silent failures.

### 7.6 Cross-team coordination implications

Two natural patterns emerge from lock-down + delegation:

1. **The Lead does not write — the worker does.** A Lead asking a worker to write outside the worker's domain produces a Layer D block. The Lead must either pick the right worker or escalate to the Orchestrator for a domain expansion or judge approval.
2. **No agent silently gets new paths.** Domain expansions are explicit YAML edits or one-time approval tokens. The audit log shows every block and every grant, so drift is visible.

---

## 8. Mental Models and Memory

### 8.1 Two complementary memory systems

| System | Purpose | Granularity | Updated by | Lifetime |
|---|---|---|---|---|
| Memory Core (existing) | Daily session journal, capture decisions/learnings/gotchas across runs | Per session, project-scoped | Memory Core flush at `session_end` and `session_before_compact` | Daily logs accumulate forever |
| Mental Models (new) | Per-agent compounding expertise loaded at agent boot | Per agent, hybrid (user-global + project-local) | Memory Core curates from VerdictEmit wisdom — agents never write directly | Persists; capped at `max_lines` per file |

### 8.2 File layout

```
~/.pi/engineering-team/
└── expertise/                        user-global (cross-project lessons)
    ├── orchestrator.md
    ├── planning-lead.md
    ├── engineering-lead.md
    ├── validation-lead.md
    ├── investigation-lead.md
    ├── planner.md
    ├── implementer.md
    ├── reviewer.md
    └── ... (one per agent)

<cwd>/.pi/engineering-team/
└── expertise/                        project-local (this-repo specifics)
    ├── orchestrator.md
    ├── planning-lead.md
    ├── implementer.md
    ├── _readonly/
    │   ├── billing-flow.md
    │   ├── deploy-checklist.md
    │   └── security-playbook.md
    └── ... (lazily created on first write)
```

Read order at agent boot: user-global first, project-local appended below. Both rendered into the agent's system prompt in a dedicated `## Expertise` section. Total combined size capped at `max_lines` (default 5000); if exceeded, oldest project-local entries truncated first, then user-global.

### 8.3 Single-writer policy

Agents never write expertise files. Their only path to expertise updates is `VerdictEmit`'s wisdom fields (already shipping today):

```typescript
VerdictEmit({
  step: "build",
  verdict: "PASS",
  learnings: ["express-rate-limit needs trust proxy when behind a load balancer"],
  decisions: ["Chose sliding window over fixed for burst handling"],
  issues_found: [],
  gotchas: ["Rate limit headers differ between v6 and v7 of the lib"]
})
```

Memory Core's `session_end` flush extends to also distribute these wisdom items to expertise files:

```
VerdictEmit wisdom → Memory Core daily log (existing) ─┐
                                                       ├─→ both flushed atomically at session_end
                  → Memory Core mental-model curator ──┘   (or session_before_compact)
                    │
                    ▼
                    Per-agent dedup against existing expertise entries
                    Append new entries to project-local <cwd>/.pi/.../expertise/<agent>.md
                    Promote to user-global ~/.pi/.../expertise/<agent>.md if:
                      - Same learning seen in N≥3 distinct projects, OR
                      - User has manually marked the project-local entry with "[promote]"
                    Enforce per-file line cap; oldest LRU entries pruned first
```

### 8.4 Lead expertise vs. worker expertise

Leads emit wisdom about *team-level decisions*: "we route migrations through the migration workflow even for trivial schema changes — judge insists." Workers emit wisdom about *craft*: "ts-jest needs `useESM: true` for our config." Leads' files lean strategic; workers' lean tactical. Same plumbing, different content shape.

### 8.5 Read-only domain knowledge files

Some knowledge should never be auto-curated — billing flows, deploy checklists, security playbooks. These are user-authored and read-only to the curator:

```
<cwd>/.pi/engineering-team/expertise/_readonly/
├── billing-flow.md
├── deploy-checklist.md
└── security-playbook.md
```

Files under `_readonly/` are loaded into the agents' system prompt with a header `## Read-only Knowledge` separate from the curated `## Expertise` section. The curator never touches them. Each `_readonly/*.md` file declares which agents see it via frontmatter:

```markdown
---
agents: ["implementer", "engineering-lead"]
loadOrder: 0
---

# Billing Flow

When implementing anything that touches the billing module...
```

### 8.6 Memory Core extensions

Three additions to the existing `MemoryCore` module:

1. `distributeWisdom(verdictPayload, agentName)` — called inline whenever a VerdictEmit is processed. Buffers wisdom by agent.
2. `flushExpertise(sessionId)` — called from `session_end` and `session_before_compact`. Iterates the buffer, applies dedup against existing expertise files, appends new entries, enforces line cap.
3. `promoteToGlobal(agentName, learning)` — invoked when an entry meets promotion criteria (N≥3 projects or `[promote]` tag).

Configuration extends `~/.pi/engineering-team/memory.json`:

```json
{
  "flushModel": "claude-haiku-4-5-20251001",
  "maxConversationTurns": 20,
  "obsidianVaultPath": null,
  "expertise": {
    "enabled": true,
    "maxLinesPerFile": 5000,
    "promoteThresholdProjects": 3,
    "globalDir": "~/.pi/engineering-team/expertise",
    "projectDirSubpath": ".pi/engineering-team/expertise"
  }
}
```

### 8.7 What this looks like to an agent

When the `implementer` boots for a session:

```
[ system prompt: standard implementer.md body ]

## Expertise
Curated from your prior runs across this project and globally.

### From this project
- ts-jest needs `useESM: true` for the config in this repo (project-local; seen in 2 prior runs)
- The `legacy/` directory uses CommonJS — do not touch its tsconfig

### Global
- express-rate-limit needs trust proxy when behind a load balancer
- Avoid `child_process.exec` with user-influenced arguments — use `execFile`

## Read-only Knowledge
### Billing Flow
[full content of billing flow doc]
```

The agent's system prompt grows over time but is bounded. Stale entries age out via LRU when the cap is hit.

---

## 9. Communication Layer

### 9.1 Conversation projection

ADWEngine writes `<run>/conversation.jsonl` as a *projection* of `events.jsonl`, filtered to user-visible dialogue:

```jsonl
{"ts": 1730000000000, "from": "user", "to": "orchestrator", "kind": "request", "text": "consult on the dark mode rollout strategy"}
{"ts": 1730000000123, "from": "orchestrator", "to": "*", "kind": "dispatch", "text": "Dispatching to engineering-lead, validation-lead, investigation-lead in parallel."}
{"ts": 1730000000456, "from": "engineering-lead", "to": "orchestrator", "kind": "position", "text": "Position written to runs/.../positions/engineering-lead.md", "ref": "<path>"}
```

Entry shape:

| Field | Description |
|---|---|
| `ts` | Epoch ms |
| `from` | Sender agent name (or `user`, `system`) |
| `to` | Recipient agent name, or `*` for broadcast |
| `kind` | `request` \| `dispatch` \| `position` \| `adversarial` \| `synthesis` \| `correction` \| `verdict` \| `note` |
| `text` | Human-readable summary (≤ 500 chars; long content goes to `ref` file) |
| `ref` | Optional file path for full content |

Source events distilled into conversation.jsonl: `message`, `verdict`, run-level `lifecycle` events (run_started, run_paused_for_user, run_completed), user inputs from Pi prompt, verifier corrective messages (kind: `correction`).

Excluded: `tool_call`, `tool_result`, `safety`, `approval`, `budget`. These stay in events.jsonl for observability but don't pollute the dialogue view.

**Read prelude.** Each agent step receives a configurable prelude injected into its prompt (default last-20 entries; per-workflow override, e.g., `consult` raises to 50). Agents can read full files via the `Read` tool when they need depth — the prelude is for orientation.

**Single writer:** ADWEngine projects from events.jsonl on every event ingestion. Append-only; never rewritten except by `/secret-scrub` retroactive cleaning.

### 9.2 TillDone with team metadata

Existing tools (`TaskList`, `TaskUpdate`) get one new optional field: `team`.

```typescript
TaskUpdate({
  taskId: "t-1",
  status: "in_progress",
  team: "engineering",       // optional, new
  owner: "engineering-lead",
  notes: "starting build phase"
})
```

**Resolution rule.** When `TaskUpdate` is called without `team`, the task is stored with `team: null`. ADWEngine marks the task as *unassigned*. At the Orchestrator's next turn, ADWEngine injects a system note: `"N tasks pending team assignment: [t-3, t-7]. Issue TaskUpdate({team: ...}) for each."` The Orchestrator reads task descriptions, decides team, and issues the updates. Resolution is batched (not synchronous per call) so workers and Leads aren't blocked by team assignment.

Why the Orchestrator (not static frontmatter inference): a worker's frontmatter team is the *team the worker belongs to*, not necessarily the *team that owns this task*. The implementer (Engineering) might surface a security concern that belongs to Validation. Static inference would mis-route. Orchestrator-driven assignment lets the cross-team coordinator make the call.

**Storage:** existing `<run>/tasks.json` gains an optional `team` field per task. Old runs without the field remain readable.

**Pi TUI footer widget.** When a run is active and tasks are present:

```
 pi-engineering │ 2m 14s                    TillDone: dark mode consult [3/5]
 └─ ⚡ Orchestrator                          ✓ engineering-lead position
    ├─ ◆ Planning Lead                        ✓ validation-lead position
    ├─ ⚡ Engineering Lead                    ✓ investigation-lead position
    └─ ◆ Validation Lead                      ● adversarial round (3 in flight)
                                              ○ synthesis
```

Two-column layout: left shows agent activity (existing `TeamRuntime` step labels), right shows task progress grouped by team. Updates live via Pi TUI's existing label channel.

**Mark-on-complete nudge.** If the Orchestrator's turn ends with `pending` or `in_progress` tasks remaining, ADWEngine sends a system reminder ("3 tasks still in flight; continue or escalate?") rather than letting the run silently idle.

### 9.3 Parallel-default delegation

Workflow step config gains two new fields:

```typescript
interface Step {
  name: string;
  agent: string;
  // ... existing fields ...
  dependsOn?: string[];        // names of steps that must complete before this one starts
  parallel?: boolean;          // default true; set false to force this step to wait for
                               // any sibling steps with the same dependsOn set
}
```

Resolution rules:

1. ADWEngine builds a step DAG at run start. A step's predecessors are the steps named in its `dependsOn`.
2. Steps that share an identical `dependsOn` set (including the empty set) form a "level". Sibling steps within a level run in parallel via `Promise.allSettled` by default.
3. A step with `parallel: false` is sequenced *after* every prior sibling in its level (sibling order taken from the workflow declaration order).
4. The next level cannot start until all steps in the prior level reach a verdict.

**Engine behavior.** ADWEngine builds a step DAG at run start, resolves levels by topological sort, runs each level's steps via `Promise.allSettled`, routes verdicts. Errors in one parallel step don't kill the others — they either pass through to the synthesis step (which sees a partial set) or block the dependent step from advancing if the failure is on a critical predecessor.

**Verifier under parallelism:** when multiple parallel steps each declare `verify: true`, the verifier runs once per worker step, in parallel with peer verifications. Verifier sessions are short-lived and cheap.

---

## 10. Rate-Limit Constraints

The deployment target uses subscription-based LLM access (e.g., Claude Max), where the binding constraint is rate (RPM, TPM, concurrent in-flight) rather than per-token cost. The system replaces cost-driven defaults with rate-driven defaults.

### 10.1 RateLimitGuard

New module `src/rateLimit/RateLimitGuard.ts`:

```typescript
interface ProviderQuota {
  provider: string;          // "anthropic", "openai", ...
  account?: string;           // optional per-account split
  rpmCeiling: number;
  tpmCeiling: number;
  windowMs: number;           // sliding window for rate calc, default 60000
}

interface RateLimitConfig {
  maxConcurrent: number;       // global semaphore, default 4
  providers: ProviderQuota[];
  warnThresholdPct: number;    // emit budget event when crossing this, default 80
  pauseThresholdPct: number;   // hold dispatch when crossing this, default 95
}
```

Stored at `~/.pi/engineering-team/rate-limits.json`. RateLimitGuard wraps `TeamRuntime`'s session.send paths. Surfaces `budget:rate-warn` and `budget:rate-pause` events into observability.

**Wiring deferred to Phase 1.5.** Phase 1 ships the RateLimitGuard module, config loader, and observer event types as standalone units with full unit-test coverage. The `acquire`/`release` integration into `TeamRuntime.deliver()` and ADW step dispatch is its own architectural change that touches every outbound LLM call site, and is scheduled for Phase 1.5 alongside the conversion of subprocess-mode `UseSecret` audit events into a per-subprocess JSONL the controller ingests.

### 10.2 Re-framings throughout

**Budget shape.** Pi-engteam's existing `maxCostUsd` becomes a secondary signal. Primary budget becomes:

- `maxConcurrent` — global semaphore on in-flight LLM requests
- `rpmCeiling` per provider/account — soft throttle that pauses dispatch when within X% of cap
- `tpmCeiling` per provider/account — same
- `maxIter` stays as iteration-count guardrail (prevents infinite loops)
- `maxCostUsd` stays as a final backstop but defaults to disabled for subscription users

**Parallel delegation respects the semaphore.** With rate-limit awareness, the engine wraps each parallel branch in a concurrency-limited queue. If `maxConcurrent=4` and a workflow wants to fan out 8 in parallel, all 8 are queued; 4 launch immediately, 4 wait. No throttle = parallel-by-default still wins; saturated = graceful degradation rather than 429s.

**Verifier under rate pressure.** Verifier requests carry a `priority: low` hint so they yield to active worker turns when the queue is full. Verifier still runs eventually; doesn't preempt productive work.

**Memory Core flush.** Flush queues itself behind any in-flight worker requests; flush model already defaults to Haiku (cheap on RPM).

**Model-routing pivot.** `model-routing.json`'s downshift rules currently key off cost threshold. New rule shape: downshift triggers off rate saturation per provider. When Anthropic Opus is at 90% of its RPM ceiling for the next 60s window, route the next eligible step to Sonnet (or to a different provider entirely if configured). Cost rules remain available; the default config for subscription users is rate-only.

**Multi-provider failover.** Pi-engteam already supports any provider Pi knows about. Rate-limit guard makes provider preference orders actually useful: `model-routing.json` can declare Anthropic primary → OpenAI secondary → Google tertiary. When primary saturates, work routes to secondary.

---

## 11. Learner Agent

### 11.1 Purpose

Verifier accuracy is a moving target. Every new domain, codebase, or workflow exposes claims existing scripts don't know how to check. Without a learning mechanism, gaps accumulate and verifier coverage decays. The Learner converts gaps into curriculum: it reads what the verifier *couldn't* verify, designs new verifier scripts (with fixtures and regression tests), and submits them for Judge approval. Verifier capability compounds.

### 11.2 Trigger and lifecycle

**Default mode: queue-then-review.**

1. **During the run** — Verifier emits `PARTIAL` or includes any unverifiable claims in its report. ADWEngine appends each unverifiable claim to a per-run gap log at `<run>/learning/gaps.jsonl`.
2. **At run completion** — ADWEngine emits a `learning:gaps_available` event if the gap log is non-empty.
3. **At user discretion** — user runs `/learn` (no args = process queue across recent runs, or `/learn <runId>` for a specific run). Spawns the Learner agent against the gap log.
4. **Learner produces** — proposed verifier-script upgrades (new scripts or edits to existing), each with a synthetic fixture demonstrating the original gap and a regression test confirming the new script catches it.
5. **Judge approval** — Learner submits each proposed change via `RequestApproval { op: "verifier-script-update", path, justification }`. Judge reviews diff + fixture + test results.
6. **Promotion** — on approval, atomic move from `.staging/` to active scripts dir. Old version archived to `.versions/<timestamp>/`. Observability event: `safety:verifier_script_updated { script, version, approved_by, fixture_path }`.

**Alternative trigger modes (configurable in `~/.pi/engineering-team/learner.json`):**

- `mode: "auto-on-completion"` — Learner runs immediately at run end without waiting for `/learn`. Higher autonomy, more rate-limit pressure.
- `mode: "manual"` — Learner only ever runs when explicitly invoked. No auto-tracking of gaps.
- `mode: "queue-then-review"` (default) — gaps accumulate; user processes when ready.

### 11.3 Internal workflow

When Learner is dispatched:

```
Step 1: gather
  - Read <run>/learning/gaps.jsonl (or batch across multiple runs)
  - Read existing verifier scripts in ~/.pi/engineering-team/verifier-scripts/
  - Read the verifier persona files
  - Read the Verifier's reports for context on each gap

Step 2: classify
  - Group gaps into improvement categories:
    a) Existing script needs new subcommand (easiest)
    b) New domain requires new script (moderate)
    c) Persona heuristic missing (author/edit persona body)
    d) Truly unverifiable in pi-engteam scope (escalate to user with a clear
       statement of what infrastructure would be needed)

Step 3: design
  - For each addressable gap, propose:
    - Target file (existing script to extend, new script to create, persona to edit)
    - Approach (CLI surface, oracle source, rejection contract)
    - A synthetic fixture: minimal failing case the original verifier missed
    - A regression test: command + expected JSON output proving the new script catches the fixture

Step 4: implement
  - Write changes to ~/.pi/engineering-team/verifier-scripts/.staging/<script>
  - Mirror existing script style (PEP-723 inline header for Python, structured JSON
    rejections, emit/reject helpers)
  - Run the staged script against the fixture; capture output

Step 5: validate
  - Run the staged script against ALL existing fixtures in
    ~/.pi/engineering-team/verifier-scripts/.fixtures/
  - Confirm no regressions: every fixture that previously PASSed still PASSes
  - Confirm coverage: the new fixture for this gap now PASSes

Step 6: request approval
  - For each staged change, RequestApproval to Judge with:
    - Diff against active version
    - Fixture path + content
    - Validation output
    - Justification ("verifier missed claim X in run Y; this script catches the fixture")

Step 7: promote
  - On approval, atomic mv from .staging/<script> to active dir
  - Archive previous version to .versions/<timestamp>/
  - Append entry to ~/.pi/engineering-team/verifier-scripts/CHANGELOG.md
  - Emit safety:verifier_script_updated event

Step 8: report
  - Write <run>/learning/report.md summarizing: gaps addressed, scripts changed,
    gaps escalated to user, next-time recommendations
  - VerdictEmit with learnings (which propagate to Memory Core mental models — the
    Verifier and Learner accumulate expertise via the same pipeline as everyone else)
```

### 11.4 Safety guarantees

Three independent gates between the Learner and active verifier scripts:

1. **Domain lock** — Learner's `upsert` is scoped to `.staging/` only. Layer D blocks any direct write to the active scripts dir.
2. **Judge approval** — promotion from staging to active is a destructive op (overwrites an active script that may run in any future run). Requires HMAC-signed approval token from Judge with `scope: once`.
3. **Fixture-and-validation contract** — promotion blocked unless the staged change produces a passing fixture *and* doesn't regress any existing fixtures. Validation output is part of the approval request; Judge reviews concrete evidence, not just a diff.

**What the Learner cannot do under any prompt:**

- Write to `~/.pi/engineering-team/verifier-scripts/` directly (only `.staging/`).
- Approve its own changes (Judge is a separate agent; HMAC enforcement at SafetyGuard).
- Modify Verifier persona allowlists in a way that broadens its own permissions (persona changes that touch `tools:`, `bash_policy:`, or `domain:` blocks require explicit user confirmation in addition to Judge approval).
- Disable existing fixtures (validation step blocks promotion if any prior fixture starts failing).

### 11.5 Compounding expertise

Verifier and Learner accumulate domain knowledge via the same `VerdictEmit` → Memory Core pipeline as all other agents. Files at `~/.pi/engineering-team/expertise/verifier.md` and `~/.pi/engineering-team/expertise/learner.md` capture: scripts authored, claim shapes learned to verify, gaps escalated and why. The Verifier reads its expertise on every run, so prior learnings inform future verification heuristics even before the Learner has authored a new script.

---

## 12. Phasing and Rollout

Five phases (Phase 3 split into 3 + 3.5 to scope the Learner separately). Each ships independently as a separate PR with its own implementation plan.

### Phase 1 — Foundation: Rate-Limit Guard + Secrets Vault

Standalone modules with no dependency on the agent-topology changes. Unlocks secure third-party API use for everything that follows. Shakes out the rate-limit signal that later phases depend on.

Ships:

- New module `src/rateLimit/RateLimitGuard.ts` + config `~/.pi/engineering-team/rate-limits.json` (module ships in Phase 1; `acquire`/`release` wiring into `TeamRuntime` deferred to Phase 1.5 — see §10.1)
- New module `src/secrets/Vault.ts`, `src/secrets/Crypto.ts`, `src/secrets/Watcher.ts`
- Encrypted SQLite at `~/.pi/engineering-team/secrets.db`
- OS-keyring integration with passphrase fallback
- New tools: `UseSecret` (registered globally, available to all agents)
- New CLI commands: `/secret-set`, `/secret-list`, `/secret-rm`, `/secret-rotate`, `/secret-export`, `/secret-import`, `/secret-scrub`
- Secret watcher hooked into Pi user-message channel
- MCP/skill manifest schema extension for declared secrets
- Observability events: `safety:secret_access`, `safety:secret_skip`, `safety:secret_scrub`, `budget:rate-warn`, `budget:rate-pause`

Tests:

- Crypto round-trip + tamper detection (GCM auth tag)
- Keyring/passphrase fallback paths
- Watcher detects all v1 patterns; produces structured prompt
- Rate-limit guard pauses dispatch at threshold; resumes when window slides
- End-to-end: paste an OpenAI-shaped key in Pi prompt → vaulted → MCP can consume it via manifest

Migration: new functionality, zero impact on existing workflows.

### Phase 2 — Topology: Lead Agents + Domain Locking

Establishes the agent hierarchy that later phases (verifier, consult, autopilot) build on.

Ships:

- 5 new agent definitions: `agents/orchestrator.md`, `agents/planning-lead.md`, `agents/engineering-lead.md`, `agents/validation-lead.md`, `agents/investigation-lead.md`
- `team:` field added to all 16 worker frontmatters
- New `domain:` block in agent frontmatter
- New config files: `~/.pi/engineering-team/teams.yaml`, `<cwd>/.pi/engineering-team/teams.local.yaml`
- New module `src/safety/DomainLock.ts` — SafetyGuard Layer D
- Default-domains shipped in `src/safety/default-domains.ts`
- `team-start` boots the 5 new lead-tier agents alongside existing 16
- Updated `engineering-doctor` health check covers new agents and domain configs

Tests:

- Each Lead's domain lock blocks writes outside declared paths with structured teaching message
- Workers writing inside their domain proceed; outside → blocked with hint pointing to teams.local.yaml
- Three-layer merge produces expected resolved policy for representative agents
- Verifier persona's `bash_policy: script-only` blocks any non-verifier-script bash

Migration: existing workflows continue working unchanged because they dispatch to workers directly. Adding domain locks is the breaking risk — ship with warn-on-block initial mode for two weeks; users surface gaps via doctor report; tighten in Phase 2.5 patch after a soak period.

### Phase 3 — Verifier Loop

Verifier needs the topology in place (it spawns alongside workers, declares its own agent definition with read-only domain) and benefits from rate-limit guard for low-priority queueing.

Ships:

- New agent `agents/verifier.md` with `read`-only tools, `bash_policy: script-only`, allowed scripts at `~/.pi/engineering-team/verifier-scripts/`
- ADWEngine extended to spawn one verifier per run, reuse for the run's lifetime
- Per-step `verify: true` flag in Workflow step config
- Verifier-flow integration: post-VerdictEmit pause → verifier check → corrective SendMessage on FAIL → bounded re-iteration via `max_verify_loops`
- Default verifier scripts: `verify_typescript.py`, `verify_python.py`, `verify_sqlite.py`, `verify_generic.py`
- Existing workflows updated with default `verify: true` on build/fix/implement/migrate steps
- `<run>/learning/gaps.jsonl` written when verifier emits PARTIAL (consumed by Phase 3.5)

Tests:

- Fixture worker emits a false claim (e.g., "FK created" with no actual migration) → verifier FAILs → corrective message → worker iterates → verifier PASSes
- `max_verify_loops` exhaustion surfaces escalation
- Verifier never gains write capability under any prompt
- Verifier's bash policy blocks non-script invocations with structured rejection
- Verifier under rate saturation queues at low priority without blocking active workers

Migration: existing workflows that don't declare `verify: true` keep current behavior. Workflows updated by this phase get verifier loops; users can opt out per step in `teams.local.yaml`.

### Phase 3.5 — Learner Agent

Rides on top of the Verifier infrastructure. Operates on Verifier's gap reports.

Ships:

- New agent `agents/learner.md`
- New CLI command `/learn`
- New module `src/learner/LearnerOrchestrator.ts` (manages the 8-step workflow)
- New approval op `verifier-script-update` in SafetyGuard's classification table
- Staging dir convention + promotion mechanism + CHANGELOG.md
- Fixtures registry at `~/.pi/engineering-team/verifier-scripts/.fixtures/`
- Versions archive at `~/.pi/engineering-team/verifier-scripts/.versions/`
- Configuration `~/.pi/engineering-team/learner.json`

Tests:

- End-to-end fixture: run a workflow that produces a deliberately-unverifiable claim → verifier emits PARTIAL → `/learn` dispatched → Learner authors a new script → Judge approves → next identical run gets PASS instead of PARTIAL
- Learner cannot write outside `.staging/` under any prompt
- Promotion blocked when fixture validation fails
- Persona changes that broaden allowlists require user confirmation

Migration: pure addition.

### Phase 4 — Workflows: Consult + Autopilot Improvements

Consult needs the Lead topology; autopilot improvements (rounds, cancel/rollback) ride on existing ADWEngine.

Ships:

- New workflow `src/workflows/consult.ts`
- New shortcut `/consult <topic> [teams=eng,valid,invest]`
- New CLI commands: `/run-cancel`, `/run-rollback`; `/run-abort` becomes alias
- RunState extensions: `phase`, `rounds: { current, max }`
- Workflow step config extensions: `parallel`, `dependsOn`
- ADWEngine DAG resolver replaces linear step iterator
- Conversation projection at `<run>/conversation.jsonl` (fed by ADWEngine event ingestion)
- Read-prelude injection into agent step prompts (default last-20 entries)

Tests:

- `/consult "should we use feature flags here?"` produces position files for selected Leads in parallel, adversarial counter-positions in parallel after positions converge, then synthesis
- `/run-cancel` mid-step → next boundary marks phase=cancelled, state preserved
- `/run-rollback` wipes run dir except `cancelled.log`
- Round budget exhaustion halts run with phase=failed
- DAG resolver detects cycles at workflow registration; rejects with clear error

Migration: old workflows still use linear step semantics by default (no `dependsOn` declared). DAG resolver treats them as a chain. No semantic change to existing workflows.

### Phase 5 — Memory: Mental Models + TillDone Footer

Pure additions; depend on having the agent topology and parallel workflows producing wisdom worth curating.

Ships:

- Memory Core extensions: `distributeWisdom`, `flushExpertise`, `promoteToGlobal`
- Hybrid expertise dirs: `~/.pi/engineering-team/expertise/` + `<cwd>/.pi/engineering-team/expertise/`
- `_readonly/` knowledge file convention with frontmatter agent targeting
- Memory config extensions in `~/.pi/engineering-team/memory.json`
- Agent boot loads expertise files into `## Expertise` section of system prompt
- `TaskList` / `TaskUpdate` `team` field; `tasks.json` schema extension
- ADWEngine team-assignment backlog mechanism (Orchestrator backfills unassigned tasks)
- Pi TUI footer widget: two-column layout with team-grouped task progress
- Mark-on-complete nudge: Orchestrator turn ending with pending tasks gets a system reminder

Tests:

- VerdictEmit wisdom propagates to expertise file at session_end with dedup
- Per-file line cap enforced via LRU
- Promotion from project-local to user-global at threshold (3 projects or `[promote]` tag)
- Read-only knowledge files load into separate prompt section; never modified by curator
- TUI footer renders correctly under all four team buckets + unassigned pile
- Orchestrator receives unassigned task notice on its next turn

Migration: new functionality. Old runs without `team` fields render in footer under "unassigned." Existing Memory Core daily logs unaffected.

### Cross-cutting requirements (every phase)

- Existing tests pass unchanged. Each phase PR includes the full test matrix; CI must show no regressions in the 12 existing workflows.
- `engineering-doctor` extended. Each phase adds health checks for its components.
- README updated incrementally. Each phase's README delta is part of its PR, not deferred.
- Backward-compatible config. Every new config file has a sensible default if missing; the extension boots without any of them present.
- Observability dashboard schema preserved. New event types are additive; existing dashboard queries continue rendering.

---

## 13. Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Domain locks break existing workflows because a worker's default doesn't cover the user's repo layout | Med | Phase 2 ships with warn-on-block initial mode for two weeks; users surface gaps via doctor report; tighten in Phase 2.5 patch |
| Verifier scripts are slow / brittle / domain-specific | Med | Ship 4 generic defaults; document the authoring pattern; verifier failure reverts to PASS+warn rather than blocking the run if the script itself errors |
| Rate-limit guard misconfigured → users see false saturation | Low | Default config conservative; doctor reports actual provider headroom against config; clear `/observe` panel surfacing rate state |
| Encrypted SQLite migration on schema change | Low | Schema versioning in vault metadata table; migrations forward-only; export/import as backup path |
| Hybrid expertise files leaking project knowledge globally | Med | Promotion gated on N≥3 projects or explicit `[promote]` tag — single-project knowledge never auto-promotes |
| Parallel delegation under provider 429 not handled cleanly | Med | RateLimitGuard's `pauseThresholdPct` holds dispatch *before* hitting the wall; if 429 still occurs, exponential backoff per branch with budget event surfaced |
| Learner authors a buggy verifier script | Med | Three-gate promotion: domain lock to staging only, fixture-and-validation contract, Judge approval with concrete evidence in the request |
| Watcher false negative on a novel key shape | Med | Conservative known-prefix patterns + user-defined patterns file; `/secret-scrub` retroactive cleanup; honest threat-model documentation |

---

## 14. Estimated Scope

Hand-wave estimates for planning purposes only:

| Phase | New files | Modified files | New tests | Best-case ship |
|---|---|---|---|---|
| 1 — Rate-limit + secrets | ~12 | ~5 | ~25 | 1 week |
| 2 — Topology + domain locking | ~10 (5 agents + safety + config) | ~12 | ~20 | 1 week |
| 3 — Verifier | ~6 | ~8 | ~15 | 4-5 days |
| 3.5 — Learner | ~5 | ~6 | ~12 | 4-5 days |
| 4 — Consult + autopilot | ~5 | ~10 | ~15 | 4-5 days |
| 5 — Memory + TillDone | ~6 | ~8 | ~15 | 4-5 days |

Total: roughly 5-7 weeks if shipped sequentially by one developer. Phases 1 and 2 are the heaviest; 3 / 3.5 / 4 / 5 are smaller and can run in parallel pairs if more hands are available.

---

## 15. File and Path Inventory

User-level (`~/.pi/engineering-team/`):

- `secrets.db` — encrypted SQLite vault
- `secrets.salt` — passphrase-fallback Argon2id salt
- `secret-patterns.json` — user-defined detection patterns
- `safety.json` — existing config, extended with `secretWatcher` block
- `teams.yaml` — user-global domain overrides
- `rate-limits.json` — RateLimitGuard config
- `model-routing.json` — existing, evolved with rate-saturation rules
- `memory.json` — existing, extended with `expertise` block
- `learner.json` — Learner trigger mode + config
- `expertise/<agent>.md` — user-global per-agent mental models
- `verifier-scripts/` — active verifier scripts
- `verifier-scripts/.staging/` — Learner's privileged write target
- `verifier-scripts/.versions/<timestamp>/` — archived prior script versions
- `verifier-scripts/.fixtures/` — fixtures registry for regression validation
- `verifier-scripts/CHANGELOG.md` — promotion history

Project-level (`<cwd>/.pi/engineering-team/`):

- `teams.local.yaml` — project-scoped domain overrides (gitignored by default)
- `expertise/<agent>.md` — project-local per-agent mental models
- `expertise/_readonly/<topic>.md` — user-authored read-only domain knowledge

Run-scoped (`~/.pi/engineering-team/runs/<runId>/`):

- `state.json` — existing, extended with `phase` and `rounds`
- `events.jsonl` — existing
- `conversation.jsonl` — projection of events.jsonl, agent-readable
- `tasks.json` — existing, extended with optional `team` field
- `positions/<lead>.md` — consult workflow output
- `adversarial/<lead>.md` — consult workflow output
- `synthesis.md` — consult workflow output
- `verification/` — verifier reports per step
- `learning/gaps.jsonl` — verifier PARTIAL gaps queued for Learner
- `learning/report.md` — Learner run report
- `cancelled.log` — debug record after `/run-rollback`
- `.pre-scrub-backup/` — backup taken by `/secret-scrub` before redaction
