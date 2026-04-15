# Agent Session Labels Design

**Date:** 2026-04-15  
**Status:** Approved (amended 2026-04-15)

## Problem

When pi-engteam runs inside Pi, all agent sessions display as "subagent" in Pi's TUI during thinking/processing. There is no way to tell which agent is active, which workflow step is in progress, or how far along the run is.

## Approach

Use `AgentSession.setSessionName()` — already provided by the Pi SDK — to display a structured label on every session. The label includes the agent role and a full step-progress indicator showing all workflow steps with ✓/●/○ completion symbols.

Example label during the build step of a 3-step workflow:

```
implementer [✓ analyze · ● build · ○ review]
```

Before any workflow runs (team booted, no steps started):

```
implementer
```

After all steps complete:

```
implementer [✓ analyze · ✓ build · ✓ review]
```

**Why single-line:** `setSessionName(name)` calls `name.trim()` internally before storing, which strips any leading/trailing newlines. The label is rendered in Pi's session selector list — a single-line display — so the progress must fit in one formatted string.

## Architecture

### Step Context Tracking (TeamRuntime)

`TeamRuntime` gains three new private fields:

```ts
private currentStepContext: { name: string } | null = null;
private completedSteps = new Set<string>();
private allSteps: string[] = [];
```

Three new public methods:

- `setStepContext(stepName, stepIndex, totalSteps, allStepNames)` — called by ADWEngine at step start; stores current step and full ordered step list; calls `refreshAllLabels()`
- `markStepComplete(stepName)` — called by ADWEngine in the `finally` block; adds step to `completedSteps`, clears `currentStepContext`, calls `refreshAllLabels()`
- `clearStepContext()` — fallback for crash paths where marking complete is not appropriate; clears `currentStepContext`, calls `refreshAllLabels()`

A private `buildSessionLabel(agentName)` maps every step in `allSteps` to one of:
- `✓ stepName` — step is in `completedSteps`
- `● stepName` — step matches `currentStepContext.name`
- `○ stepName` — step is pending

Steps are joined with ` · ` and wrapped: `agentName [indicators]`. Falls back to bare `agentName` when `allSteps` is empty.

A private `refreshAllLabels()` iterates all sessions and calls `session.setSessionName(buildSessionLabel(name))` for each — so every agent in the team simultaneously shows the latest workflow progress.

### Session Name Lifecycle

| Moment | All session labels set to |
|--------|--------------------------|
| `ensureTeammate` (agent created) | `agentName` (no steps known yet) |
| `setStepContext` (step starts) | `agentName [○ s1 · ● s2 · ○ s3]` — all sessions refreshed |
| `markStepComplete` (step ends) | `agentName [✓ s1 · ✓ s2 · ○ s3]` — all sessions refreshed |
| `deliver` (agent receives task) | Same as current label (ensures label is set even if session was created before any steps) |

### ADWEngine Integration

In `executeRun`, around each step invocation:

```ts
const stepIndex = workflow.steps.findIndex(s => s.name === state.currentStep);
this.config.team.setStepContext(
  state.currentStep,
  stepIndex,
  workflow.steps.length,
  workflow.steps.map(s => s.name),
);
try {
  result = await stepDef.run(ctx);
} catch (err) {
  result = { ... };
} finally {
  this.config.team.markStepComplete(state.currentStep);
}
```

`markStepComplete` replaces `clearStepContext` in the `finally` block. `clearStepContext` is retained as a fallback but is not called by ADWEngine in normal flow.

## Files Changed

| File | Change |
|------|--------|
| `src/team/TeamRuntime.ts` | Add `currentStepContext`, `completedSteps`, `allSteps`; add `setStepContext` (with allStepNames param), `markStepComplete`, `clearStepContext`, `buildSessionLabel`, `refreshAllLabels`; call `buildSessionLabel` in `ensureTeammate` and `deliver` |
| `src/adw/ADWEngine.ts` | Pass all step names to `setStepContext`; call `markStepComplete` (not `clearStepContext`) in `finally` |
| `tests/unit/adw/ADWEngine.test.ts` | Add `markStepComplete: vi.fn()` to `makeMockTeam()` |

## Acceptance Criteria

- Pi's TUI shows `agentName` (not "subagent") for every team session at boot
- Once any step starts, all session labels show the full step list with ✓/●/○ indicators
- While a step is running, that step shows `●`; completed steps show `✓`; pending steps show `○`
- If the step crashes, `markStepComplete` still runs (finally block) — label stays accurate, no stale ● indicator
- All agents in the team show the same step progress simultaneously (not just the active agent)
- No existing tests broken; no behavior changes outside display labels

## Out of Scope

- Per-message label updates within a step
- Custom label formatting / theming
- Surfacing step progress in the dashboard or HTTP sink events
- Distinguishing PASS vs FAIL steps visually (all completed steps show ✓)
