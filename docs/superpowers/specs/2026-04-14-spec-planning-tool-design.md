# Spec: Pi Feature Planning Tool

**Date:** 2026-04-14  
**Status:** Approved

---

## Problem

Pi's existing `/plan` command starts a workflow that immediately puts the AI to work building. There is no structured discovery phase to understand requirements, no spec artifact for the team to agree on, and no gated checkpoint before the build begins. Separately, the Superpowers brainstorming skill does thorough discovery and spec writing, but it runs outside Pi's TUI and produces documents that never connect to an actual build workflow.

The goal is to combine the best of both: structured human-in-the-loop discovery (Superpowers style) with Pi's build pipeline, all within the CLI — no separate tools, no context switching.

---

## Approach

Introduce a `/spec` command that starts a new `spec-plan-build-review` workflow. The workflow is a five-step pipeline where steps 2, 3, and 4 each produce an artifact and then pause for human review and approval before continuing. The existing `/plan` command is unchanged.

**Entry point**
- `/spec "goal"` — starts the full discovery-through-review pipeline  
- `/plan "goal"` — unchanged; starts the existing plan-build-review workflow

**Five-step workflow**

| Step | Agent | Produces | Pause? |
|------|-------|----------|--------|
| `discover` | Discoverer | `questions.md` | yes — TUI wizard |
| `design` | Architect | `spec.md` | yes — approve |
| `plan` | Planner | `plan.md` | yes — approve |
| `build` | Builder (existing) | code | no |
| `review` | Reviewer (existing) | review report | no |

---

## Architecture

### Engine Extension: `waiting_user` Status

The workflow engine gains a new run status `waiting_user` and a matching step property `pauseAfter`. When a step completes with PASS verdict and `pauseAfter: true`, the engine:

1. Writes a pause notification to the run log
2. Sets run status to `waiting_user`
3. Writes `<cwd>/.pi/engteam/active-run.json` with `{ runId, phase: "approving" | "answering", stepName }`

`active-run.json` is stored in the current working directory (not `~/.pi/`), so simultaneous runs across different projects never collide.

### `executeUntilPause(runId)`

A new engine method used by the `/spec` command handler. It runs the workflow loop until run status becomes `waiting_user`, then returns. The command handler is responsible for setting up the appropriate input hook before calling this.

### Input Hook

`pi.on("input", handler)` intercepts all user messages in the Pi session. The handler reads `active-run.json` to determine the current phase:

- **`answering`** — the user has typed their wizard answers; forward the message content to the run's input queue and clear `active-run.json`
- **`approving`** — if the message contains an approval keyword (`approve`, `approved`, `looks good`), signal approval and resume the run via `executeUntilPause`; otherwise echo a prompt reminding the user what to do

The input hook is registered once when the extension loads and is always active while an `active-run.json` exists.

---

## Step Details

### Step 1 — `discover`

**Agent:** Discoverer (new, lightweight)  
**Pause after:** yes — type `waiting_user`, phase `answering`

The Discoverer agent reads the user's goal and produces `<run-dir>/questions.md` — a structured file of 3–5 discovery questions organized into categories: SCOPE, CONSTRAINTS, SUCCESS, CONTEXT.

After writing `questions.md` and emitting PASS, the engine pauses. The `/spec` command handler reads `questions.md`, renders the TUI wizard, collects answers, writes `<run-dir>/answers.md`, then resumes the engine.

**`questions.md` format:**

```markdown
## SCOPE
1. Who are the primary users and what task are they trying to complete?
2. What are the hard boundaries — what will this explicitly not do?

## CONSTRAINTS
3. Are there technology, platform, or timeline constraints to work within?

## SUCCESS
4. What does a successful outcome look like? What would make this feel done?

## CONTEXT
5. Is there existing code, a prior design, or related work this should connect to?
```

### Step 2 — `design`

**Agent:** Architect  
**Pause after:** yes — type `waiting_user`, phase `approving`

The Architect reads `goal.txt` + `answers.md` and writes `<run-dir>/spec.md` using the ADR-style structure:

- **Problem** — what is broken or missing
- **Approach** — chosen solution and why
- **Acceptance Criteria** — observable, testable outcomes
- **Key Interfaces** — public API shapes, data models, protocol contracts
- **Out of Scope** — explicit exclusions to prevent scope creep
- **Open Questions** — unresolved decisions to be made during implementation

After writing `spec.md` and emitting PASS, the engine pauses. Pi prints:

```
spec written → .pi/engteam/runs/<id>/spec.md
type "approve" when ready to write the plan
```

### Step 3 — `plan`

**Agent:** Planner  
**Pause after:** yes — type `waiting_user`, phase `approving`

The Planner reads `spec.md` and writes `<run-dir>/plan.md` — a checkbox task list grouped by logical phase, with tier hints (`fast` / `standard` / `reasoning`) on each task.

After writing `plan.md` and emitting PASS, the engine pauses. Pi prints:

```
plan written → .pi/engteam/runs/<id>/plan.md
type "approve" when ready to build
```

### Step 4 — `build`

The existing Builder agent. No changes. Does not pause.

### Step 5 — `review`

The existing Reviewer agent. No changes. Does not pause.

---

## TUI Wizard — `QuestionWizard` Component

Built using `ctx.ui.custom()`. Blocks the session until the user submits answers. Returns the completed answers as a structured object.

**Layout:**
- Category tabs across the top — `→` / `←` to navigate between categories
- For the active category: question label above each text input
- `Tab` moves focus to the next input within the category
- `Ctrl+Enter` submits all answers

**No outer border.** Content renders directly — tabs and inputs without an enclosing rectangular outline.

**Behavior:**
- All categories and questions are rendered at load time (no paging)
- User can jump between categories freely; answers persist when switching tabs
- Submission requires all required questions to have a non-empty answer; incomplete fields are highlighted
- On submit, wizard writes `answers.md` in the run directory and calls `done()`

---

## Key Interfaces

```typescript
// Engine
type RunStatus = "running" | "complete" | "failed" | "waiting_user";

interface Step {
  name: string;
  agent: Agent;
  pauseAfter?: boolean;
}

interface ActiveRun {
  runId: string;
  phase: "answering" | "approving";
  stepName: string;
}

// Engine method
async function executeUntilPause(runId: string): Promise<void>

// Wizard
interface QuestionCategory {
  name: string;        // e.g. "SCOPE"
  questions: string[]; // question text
}

async function showQuestionWizard(
  ctx: PiContext,
  categories: QuestionCategory[]
): Promise<Record<string, string[]>>;  // category → answers

// active-run.json location
const ACTIVE_RUN_PATH = join(process.cwd(), ".pi", "engteam", "active-run.json");
```

---

## Acceptance Criteria

- `pi /spec "add dark mode"` starts the five-step workflow and the discover step runs immediately
- After discover completes, a tabbed TUI wizard appears with the questions from `questions.md`; the user fills in answers and submits with `Ctrl+Enter`
- After design completes, Pi prints the spec path and waits; typing `approve` resumes execution
- After plan completes, Pi prints the plan path and waits; typing `approve` starts the build
- Two simultaneous `/spec` runs in different project directories do not interfere (separate `active-run.json` files)
- `/plan` continues to work exactly as before
- The wizard renders without an outer border

---

## Out of Scope

- Editing spec or plan from within the TUI (user opens the file in their editor)
- `/spec` over an existing run (resuming a paused spec workflow)
- Multi-model routing within the five-step pipeline (all agents use the configured default)
- Streaming spec/plan content into the TUI as it is written

---

## Open Questions

- Should the wizard support multi-line text inputs for answers that benefit from more detail, or are single-line inputs sufficient for discovery questions?
- What happens if the user closes Pi mid-wizard (partial answers)? Currently they restart the run. Is that acceptable?
- Should `approve` be case-insensitive only, or also support common abbreviations like `lgtm`?
