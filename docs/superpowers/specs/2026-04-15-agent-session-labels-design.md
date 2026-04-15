# Agent Session Labels Design

**Date:** 2026-04-15  
**Status:** Approved

## Problem

When pi-engteam runs inside Pi, all agent sessions display as "subagent" in Pi's TUI during thinking/processing. There is no way to tell which agent is active, which workflow step is in progress, or how far along the run is.

## Approach

Use `AgentSession.setSessionName()` — already provided by the Pi SDK — to display a structured label on every session. The label includes the agent role, the current step index/total, and the step name.

Example label during the build step of a 3-step workflow:

```
implementer [step 2/3 · build]
```

Before any step is active (team booted but no run started):

```
implementer
```

## Architecture

### Step Context Tracking (TeamRuntime)

`TeamRuntime` gains a private `currentStepContext` field:

```ts
private currentStepContext: { name: string; index: number; total: number } | null = null;
```

Two new public methods:

- `setStepContext(stepName: string, stepIndex: number, totalSteps: number): void` — called by ADWEngine at step start
- `clearStepContext(): void` — called by ADWEngine after step completes (in a `finally` block)

A private helper `buildSessionLabel(agentName: string): string` returns the formatted label or falls back to `agentName` when no context is set.

### Session Name Lifecycle

| Moment | Session name set to |
|--------|---------------------|
| `ensureTeammate` (agent created) | `agentName` |
| `deliver` (agent receives a task) | `agentName [step N/T · stepName]` |
| Step ends / crashes | context cleared; next deliver resets |

### ADWEngine Integration

In `executeRun`, around each step invocation:

```ts
const stepIndex = workflow.steps.findIndex(s => s.name === state.currentStep);
this.config.team.setStepContext(state.currentStep, stepIndex, workflow.steps.length);
try {
  result = await stepDef.run(ctx);
} catch (err) {
  result = { ... };
} finally {
  this.config.team.clearStepContext();
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/team/TeamRuntime.ts` | Add `currentStepContext`, `setStepContext`, `clearStepContext`, `buildSessionLabel`; call `setSessionName` in `ensureTeammate` and `deliver` |
| `src/adw/ADWEngine.ts` | Call `setStepContext` before each step, `clearStepContext` in `finally` |

## Acceptance Criteria

- Pi's TUI shows `agentName` (not "subagent") for every team session at boot
- While a step is running, the active agent's label reads `agentName [step N/T · stepName]`
- If the step crashes, the label is cleared correctly (no stale step context)
- No existing tests broken; no behavior changes outside display labels

## Out of Scope

- Per-message label updates beyond the step boundary
- Custom label formatting / theming
- Surfacing step context in the dashboard or HTTP sink events
