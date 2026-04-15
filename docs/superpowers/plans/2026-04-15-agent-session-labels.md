# Agent Session Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pi's generic "subagent" label with a full step-progress indicator — `agentName [✓ step1 · ● step2 · ○ step3]` — so the active agent and all step completion states are visible while a workflow runs.

**Architecture:** `TeamRuntime` gains `completedSteps`, `allSteps`, and `currentStepContext` fields plus `setStepContext`/`markStepComplete`/`clearStepContext`/`refreshAllLabels` methods. A private `buildSessionLabel` maps each step to ✓/●/○. All session labels are refreshed simultaneously whenever step state changes. `ADWEngine.executeRun` calls `setStepContext` (passing all step names) before each step and `markStepComplete` in the `finally` block.

**Tech Stack:** TypeScript, `@mariozechner/pi-coding-agent` `AgentSession.setSessionName()`

---

### Task 1: Update TeamRuntime with step progress tracking and session labels

**Files:**
- Modify: `src/team/TeamRuntime.ts`
- Modify: `tests/unit/adw/ADWEngine.test.ts` (mock team needs new methods)

- [ ] **Step 1: Replace `src/team/TeamRuntime.ts` with the updated version**

```typescript
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition, TeamMessage } from "../types.js";
import type { MessageBus } from "./MessageBus.js";
import type { Observer } from "../observer/Observer.js";

type TeamRuntimeConfig = {
  cwd: string;
  bus: MessageBus;
  observer: Observer;
  runsDir: string;
  customToolsFor: (agentName: string) => any[];
};

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class TeamRuntime {
  private sessions = new Map<string, AgentSession>();
  private currentStepContext: { name: string } | null = null;
  private completedSteps = new Set<string>();
  private allSteps: string[] = [];

  constructor(private config: TeamRuntimeConfig) {}

  private teamSuffix(name: string): string {
    return `\n\n---\n## Team Context\nYour name in the team is: **${name}**\nUse SendMessage to communicate with other agents. Use VerdictEmit to signal task completion.\nAlways end your turn with VerdictEmit when you have completed your assigned step.`;
  }

  setStepContext(stepName: string, _stepIndex: number, _totalSteps: number, allStepNames: string[]): void {
    this.currentStepContext = { name: stepName };
    this.allSteps = allStepNames;
    this.refreshAllLabels();
  }

  markStepComplete(stepName: string): void {
    this.completedSteps.add(stepName);
    this.currentStepContext = null;
    this.refreshAllLabels();
  }

  clearStepContext(): void {
    this.currentStepContext = null;
    this.refreshAllLabels();
  }

  private buildSessionLabel(agentName: string): string {
    if (this.allSteps.length === 0) return agentName;
    const indicators = this.allSteps
      .map(step => {
        if (this.completedSteps.has(step)) return `✓ ${step}`;
        if (step === this.currentStepContext?.name) return `● ${step}`;
        return `○ ${step}`;
      })
      .join(" · ");
    return `${agentName} [${indicators}]`;
  }

  private refreshAllLabels(): void {
    for (const [name, session] of this.sessions) {
      session.setSessionName(this.buildSessionLabel(name));
    }
  }

  async ensureTeammate(name: string, def: AgentDefinition): Promise<void> {
    if (this.sessions.has(name)) return;

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    let model: any;
    try {
      const { getModel } = await import("@mariozechner/pi-ai");
      model = getModel("anthropic", def.model as any) ?? getModel("anthropic", "claude-sonnet-4-6");
    } catch {
      model = { id: def.model };
    }

    if (!model) throw new Error(`Model not found for agent ${name}: ${def.model}`);

    const loader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      systemPrompt: def.systemPrompt + this.teamSuffix(name),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      model,
      authStorage,
      modelRegistry,
      tools: createCodingTools(this.config.cwd),
      customTools: this.config.customToolsFor(name),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });

    this.sessions.set(name, session);
    session.setSessionName(this.buildSessionLabel(name));

    this.config.observer.subscribeToSession(
      session as any,
      "active",
      name,
    );
  }

  async ensureAllTeammates(definitions: AgentDefinition[]): Promise<void> {
    await Promise.all(definitions.map(def => this.ensureTeammate(def.name, def)));
  }

  async deliver(to: string, message: TeamMessage): Promise<void> {
    const session = this.sessions.get(to);
    if (!session) throw new Error(`Teammate '${to}' is not running. Call ensureTeammate first.`);
    session.setSessionName(this.buildSessionLabel(to));
    const prompt = `<task-notification from="${message.from}">\n${message.message}\n</task-notification>`;
    await (session as any).prompt(prompt);
  }

  async deliverAll(message: Omit<TeamMessage, "to">): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.keys()).map(name =>
        this.deliver(name, { ...message, to: name })
      )
    );
  }

  getSession(name: string): AgentSession | undefined {
    return this.sessions.get(name);
  }

  async disposeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      (session as any).dispose();
    }
    this.sessions.clear();
  }
}
```

- [ ] **Step 2: Add `setStepContext`, `markStepComplete`, and `clearStepContext` to the mock team in the ADWEngine test**

In `tests/unit/adw/ADWEngine.test.ts`, find `makeMockTeam()` and replace it:

```typescript
function makeMockTeam() {
  return {
    ensureTeammate: vi.fn(),
    ensureAllTeammates: vi.fn(),
    deliver: vi.fn(),
    disposeAll: vi.fn(),
    setStepContext: vi.fn(),
    markStepComplete: vi.fn(),
    clearStepContext: vi.fn(),
  } as any;
}
```

- [ ] **Step 3: Run tests to verify the mock change doesn't break anything**

Run: `pnpm test tests/unit/adw/ADWEngine.test.ts`
Expected: all ADWEngine tests pass

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

---

### Task 2: Wire step progress into ADWEngine and commit

**Files:**
- Modify: `src/adw/ADWEngine.ts` (around line 132)

- [ ] **Step 1: Locate the step execution block in `src/adw/ADWEngine.ts`**

Find this block (around line 132):

```typescript
      const stepStart = Date.now();
      let result: StepResult;

      try {
        const ctx: StepContext = {
          run: state,
          team: this.config.team,
          observer: this.config.observer,
          engine: this,
        };
        result = await stepDef.run(ctx);
      } catch (err) {
        result = {
          success: false,
          verdict: "FAIL",
          error: err instanceof Error ? err.message : String(err),
        };
      }
```

- [ ] **Step 2: Replace it with the version that pushes step progress and marks completion**

```typescript
      const stepStart = Date.now();
      const stepIndex = workflow.steps.findIndex(s => s.name === state.currentStep);
      this.config.team.setStepContext(
        state.currentStep,
        stepIndex,
        workflow.steps.length,
        workflow.steps.map(s => s.name),
      );
      let result: StepResult;

      try {
        const ctx: StepContext = {
          run: state,
          team: this.config.team,
          observer: this.config.observer,
          engine: this,
        };
        result = await stepDef.run(ctx);
      } catch (err) {
        result = {
          success: false,
          verdict: "FAIL",
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.config.team.markStepComplete(state.currentStep);
      }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/team/TeamRuntime.ts src/adw/ADWEngine.ts tests/unit/adw/ADWEngine.test.ts
git commit -m "feat: show full step progress in Pi session labels (✓/●/○ per step)"
```
