# Spec: Issue Analyst Agent

**Date:** 2026-04-15  
**Status:** Approved

---

## Problem

Pi's workflows start from a free-text goal typed at the prompt. There is no structured path from an existing issue ticket — filed in GitHub, Azure DevOps, or Jira — into the build pipeline. Users have to manually copy ticket details into a goal string and pick the right workflow themselves. Context gets lost in translation, and the wrong workflow gets picked just as often as the right one.

---

## Approach

Add an `issue-analyst` agent and an `/issue` command. The command runs a single-step `issue-analyze` workflow that fetches the ticket via a pre-authenticated CLI, extracts a structured `issue-brief.md` artifact, and auto-chains into the appropriate downstream workflow (`spec-plan-build-review`, `debug`, `fix-loop`, or `plan-build-review`). The downstream workflow receives the brief as an initial artifact so every agent in the pipeline has full ticket context.

**Entry point**

```
/issue <ticket-url-or-id> [--tracker github|ado|jira]
```

**Two-phase execution**

```
Phase 1 — issue-analyze workflow (single step)
  issue-analyst fetches ticket via CLI
  writes issue-brief.md
  emits PASS with suggested workflow + distilled goal

Phase 2 — auto-chain
  command handler reads issue-brief.md
  copies brief into new run directory as initial artifact
  launches suggested workflow
```

The downstream workflows are **unchanged**. The brief travels through as artifact context. For `spec-plan-build-review`, the TUI wizard still runs — the discoverer sees the brief and may ask fewer questions, but no wizard logic is bypassed.

---

## Architecture

### New files

| File | Responsibility |
|------|---------------|
| `agents/issue-analyst.md` | Agent definition — haiku model, system prompt, tool list |
| `src/workflows/issue-analyze.ts` | Single-step workflow: one `analyze` step dispatched to `issue-analyst` |
| `src/commands/issue.ts` | `/issue` command — arg parsing, two-phase execution, workflow chaining |
| `src/commands/issue-tracker.ts` | Tracker detection — URL patterns, `--tracker` flag, config file, git remote |

### Modified files

| File | Change |
|------|--------|
| `src/safety/classifier.ts` | Add `gh`, `az`, `jira` as safe verbs with read-only subcommand gates |
| `src/types.ts` | Add `initialArtifacts?: string[]` to `RunConfig` |
| `src/adw/ADWEngine.ts` | `startRun` stores `initialArtifacts` paths in `RunState.artifacts` before first step |
| `src/index.ts` | Register workflow, command, and agent |

### Tracker detection — `issue-tracker.ts`

Resolves tracker type by working through this chain, stopping at the first match:

1. **URL pattern** — `github.com/*/issues/*` → `github`; `dev.azure.com` or `*.visualstudio.com` → `ado`; `*.atlassian.net/browse/*` → `jira`
2. **`--tracker` flag** — explicit override, always wins over inference
3. **AGENTS.md / CLAUDE.md** — agent reads these files in the project root and looks for tracker mentions. If `tracker: "unknown"` is passed to the agent, it reads these files as part of its context-gathering before attempting the CLI call
4. **`~/.pi/engteam/issue-tracker.json`** — optional config: `{ "default": "github" | "ado" | "jira" }`
5. **`git remote -v`** — parse remote URL for `github.com`, `dev.azure.com`, `visualstudio.com`
6. **Error** — clear message explaining all five detection paths and how to configure each

Steps 1, 2, 4, and 5 execute in TypeScript (in `issue-tracker.ts`). Step 3 is performed by the agent at runtime.

### `initialArtifacts` engine change

`RunConfig` gains an optional field:

```typescript
interface RunConfig {
  workflow: string;
  goal: string;
  budget: BudgetConfig;
  initialArtifacts?: string[]; // absolute file paths pre-loaded into first StepContext
}
```

`startRun` stores these paths in `RunState.artifacts` before the first step executes. No other engine logic changes — the artifact list already flows into every `StepContext`.

### Safety classifier changes

Three new safe-verb entries, each with a read-only subcommand gate:

| Verb | Safe subcommands |
|------|-----------------|
| `gh` | `issue view`, `issue list`, `pr view`, `pr list`, `repo view` |
| `az` | `boards work-item show`, `boards work-item list`, `repos pr show` |
| `jira` | `issue view`, `issue list` |

Any other subcommand for these verbs falls through to `destructive`.

---

## Agent: `issue-analyst`

**Model:** `claude-haiku-4-5-20251001`  
**Tools:** `Read, Grep, Glob, Bash, VerdictEmit`

### CLI commands

| Tracker | Command |
|---------|---------|
| `github` | `gh issue view <id> --json number,title,body,labels,state,assignees,milestone` |
| `ado` | `az boards work-item show --id <id> --output json` |
| `jira` | `jira issue view <id> --plain` |

### Behavior

1. Resolve tracker type from the context provided. If `tracker: "unknown"`, read `AGENTS.md` and `CLAUDE.md` in the project root, then `~/.pi/engteam/issue-tracker.json`, then run `git remote -v`
2. Run the appropriate CLI command via `Bash`
3. Parse the JSON (or plain text) output
4. Write `issue-brief.md` to the run directory
5. Select suggested workflow:
   - `feature` / `enhancement` / `story` → `spec-plan-build-review`
   - `bug` with clear reproduction steps → `fix-loop`
   - `bug` with unknown or unclear cause → `debug`
   - `task` / `chore` / `refactor` → `plan-build-review`
6. Emit `VerdictEmit` with `step="analyze"`, `verdict="PASS"`, `artifacts=["issue-brief.md"]`

### `issue-brief.md` format

```markdown
# Issue Brief: <title>

## Source
Tracker: github | ado | jira
ID: <ticket-id>
URL: <url if available>
Type: feature | bug | task
Priority: <label or severity>
Status: <open | in-progress | closed>

## Problem / Request
<extracted from ticket body>

## Acceptance Criteria
<extracted or inferred, bulleted list>

## Context
<labels, linked issues, assignees, milestone>

## Suggested Workflow
<spec-plan-build-review | debug | fix-loop | plan-build-review>

## Goal
<one-sentence goal distilled from the ticket, ready to pass directly to the workflow>
```

---

## Command: `/issue`

```
/issue <ticket-url-or-id> [--tracker github|ado|jira]
```

**Handler flow:**

1. Parse `--tracker` flag and ticket reference from args
2. Call `detectTracker(ticketRef, trackerFlag)` from `issue-tracker.ts` — returns `{ tracker, ticketId }` or `{ tracker: "unknown" }`
3. Start `issue-analyze` run: `engine.startRun({ workflow: "issue-analyze", goal: \`${ticketRef} [tracker:${tracker}]\`, budget: {} })` — tracker type is embedded in the goal string so the agent receives it in `StepContext.goal`
4. `await engine.executeRun(runId)` — wait for completion before reading the brief
5. Read `issue-brief.md` from the run directory
6. Parse `Suggested Workflow` and `Goal` fields
7. Create the downstream run: `engine.startRun({ workflow: suggestedWorkflow, goal: extractedGoal, budget: {}, initialArtifacts: [briefPath] })`
8. If downstream is `spec-plan-build-review`: call `executeSpecWorkflow(pi, engine, team, agentDefs, runsDir, downstreamRunId, ctx)` — a shared function extracted from the `/spec` command handler that shows the wizard and handles the approval-gate phases. Both `/spec` and `/issue` call this function.
9. Otherwise: `void engine.executeRun(downstreamRunId)` and notify user

---

## Key Interfaces

```typescript
// issue-tracker.ts
export type TrackerType = "github" | "ado" | "jira" | "unknown";

export interface TrackerResolution {
  tracker: TrackerType;
  ticketId: string;
}

export async function detectTracker(
  input: string,
  explicitTracker?: string
): Promise<TrackerResolution>

// types.ts addition
interface RunConfig {
  workflow: string;
  goal: string;
  budget: BudgetConfig;
  initialArtifacts?: string[];
}

// spec.ts — shared function called by both /spec and /issue (when chaining to spec-plan-build-review)
async function executeSpecWorkflow(
  pi: ExtensionAPI,
  engine: ADWEngine,
  team: TeamRuntime,
  agentDefs: AgentDefinition[],
  runsDir: string,
  runId: string,
  ctx: CommandContext
): Promise<void>
```

---

## Acceptance Criteria

- `/issue https://github.com/org/repo/issues/42` fetches the ticket using `gh issue view`, writes `issue-brief.md`, and auto-chains into the correct workflow
- `/issue PROJ-123 --tracker jira` fetches the ticket using `jira issue view PROJ-123`
- `/issue ADO-99 --tracker ado` fetches the ticket using `az boards work-item show --id 99`
- When tracker cannot be detected, the command prints a clear error listing all five detection paths
- A feature ticket chains into `spec-plan-build-review` and the TUI wizard runs normally with `issue-brief.md` available as context to the discoverer
- A bug ticket with reproduction steps chains into `fix-loop`; a bug with unclear cause chains into `debug`
- `gh issue view`, `az boards work-item show`, and `jira issue view` are classified as safe (no approval token required)
- `initialArtifacts` paths appear in the first `StepContext.artifacts` of the downstream run
- `/plan` and `/spec` continue to work exactly as before

---

## Out of Scope

- Updating or closing tickets from within Pi
- Fetching multiple tickets in one command
- Linear, Shortcut, or other trackers beyond GitHub, ADO, and Jira
- Pagination for `gh issue list` / `az boards work-item list`
- Authentication setup — all three CLIs are assumed to be pre-authenticated

---

## Open Questions

- Should the `az boards work-item show` command require a `--org` and `--project` flag, or can those be set via `az devops configure --defaults`? The agent should check `az devops configure --list` if the first attempt fails.
- Should `jira issue view` fall back to the Atlassian REST API via `curl` if the `jira` CLI is not installed?
