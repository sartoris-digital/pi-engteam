# Spec Planning Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/spec` command that runs a gated discover → design → plan → build → review pipeline with a TUI wizard for requirement discovery and natural-text approval gates before each build phase.

**Architecture:** Extend the ADW engine with a `waiting_user` run status and a `pauseAfter` step property. The discover step writes `questions.md`; the `/spec` command handler shows a tabbed TUI wizard to collect answers, then resumes the engine. Design and plan steps each pause with an approval gate driven by a global `pi.on("input")` hook that reads per-project `active-run.json` state. Build and review steps are unchanged.

**Tech Stack:** TypeScript, vitest, `@mariozechner/pi-tui` (Input, matchesKey, TUI, Component), `@mariozechner/pi-coding-agent` (ExtensionAPI, Theme), fs/promises

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/adw/ActiveRun.ts` | Read/write/clear `<cwd>/.pi/engteam/active-run.json` |
| Create | `src/commands/spec-utils.ts` | Parse `questions.md`; format `answers.md` |
| Create | `src/ui/QuestionWizard.ts` | TUI wizard component (tabs + Input fields) |
| Create | `src/workflows/spec-plan-build-review.ts` | 5-step workflow definition |
| Create | `src/commands/spec.ts` | `/spec` command registration |
| Modify | `src/types.ts` | Add `"waiting_user"` to `RunStatus` |
| Modify | `src/workflows/types.ts` | Add `pauseAfter?` to `Step` |
| Modify | `src/adw/ADWEngine.ts` | Pause logic + `executeUntilPause` method |
| Modify | `src/index.ts` | Register discoverer/architect agents, workflow, command, input hook |
| Create | `tests/unit/adw/ActiveRun.test.ts` | Unit tests for ActiveRun helpers |
| Create | `tests/unit/commands/spec-utils.test.ts` | Unit tests for parser/formatter |
| Create | `tests/unit/ui/QuestionWizard.test.ts` | Unit tests for wizard component |
| Create | `tests/unit/workflows/spec-plan-build-review.test.ts` | Workflow shape tests |
| Modify | `tests/unit/adw/ADWEngine.test.ts` | Add pause-behavior tests |

---

## Task 1: Extend type definitions

**Files:**
- Modify: `src/types.ts`
- Modify: `src/workflows/types.ts`

- [ ] **Step 1: Write the failing typecheck**

Run: `npm run typecheck`
Expected: passes (baseline — capture current state)

- [ ] **Step 2: Add `waiting_user` to `RunStatus` in `src/types.ts`**

In `src/types.ts`, line 13, change:
```typescript
export type RunStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "aborted";
```
To:
```typescript
export type RunStatus = "pending" | "running" | "paused" | "waiting_user" | "succeeded" | "failed" | "aborted";
```

- [ ] **Step 3: Add `pauseAfter?` to `Step` in `src/workflows/types.ts`**

In `src/workflows/types.ts`, change:
```typescript
export type Step = {
  name: string;
  required: boolean;
  run: (ctx: StepContext) => Promise<StepResult>;
};
```
To:
```typescript
export type Step = {
  name: string;
  required: boolean;
  /** If set, engine pauses with this phase after a PASS verdict */
  pauseAfter?: "answering" | "approving";
  run: (ctx: StepContext) => Promise<StepResult>;
};
```

- [ ] **Step 4: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/workflows/types.ts
git commit -m "feat: add waiting_user RunStatus and pauseAfter Step property"
```

---

## Task 2: ActiveRun helpers

**Files:**
- Create: `src/adw/ActiveRun.ts`
- Create: `tests/unit/adw/ActiveRun.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/adw/ActiveRun.test.ts`:
```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;

async function withCwd(dir: string, fn: () => Promise<void>) {
  const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

describe("ActiveRun", () => {
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("readActiveRun returns null when file does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-run-test-"));
    const { readActiveRun } = await import("../../../src/adw/ActiveRun.js");
    await withCwd(tmpDir, async () => {
      const result = await readActiveRun();
      expect(result).toBeNull();
    });
  });

  it("writeActiveRun then readActiveRun returns the written state", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-run-test-"));
    const { writeActiveRun, readActiveRun } = await import("../../../src/adw/ActiveRun.js");
    const state = { runId: "run-abc", phase: "approving" as const, stepName: "design", runsDir: "/tmp/runs" };
    await withCwd(tmpDir, async () => {
      await writeActiveRun(state);
      const result = await readActiveRun();
      expect(result).toEqual(state);
    });
  });

  it("clearActiveRun removes the file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-run-test-"));
    const { writeActiveRun, readActiveRun, clearActiveRun } = await import("../../../src/adw/ActiveRun.js");
    const state = { runId: "run-abc", phase: "answering" as const, stepName: "discover", runsDir: "/tmp/runs" };
    await withCwd(tmpDir, async () => {
      await writeActiveRun(state);
      await clearActiveRun();
      const result = await readActiveRun();
      expect(result).toBeNull();
    });
  });

  it("clearActiveRun does not throw when file is absent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-run-test-"));
    const { clearActiveRun } = await import("../../../src/adw/ActiveRun.js");
    await withCwd(tmpDir, async () => {
      await expect(clearActiveRun()).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/unit/adw/ActiveRun.test.ts`
Expected: FAIL — `ActiveRun.js` not found

- [ ] **Step 3: Create `src/adw/ActiveRun.ts`**

```typescript
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";

export type ActiveRunState = {
  runId: string;
  phase: "answering" | "approving";
  stepName: string;
  runsDir: string;
};

function activeRunPath(): string {
  return join(process.cwd(), ".pi", "engteam", "active-run.json");
}

export async function writeActiveRun(state: ActiveRunState): Promise<void> {
  const dir = join(process.cwd(), ".pi", "engteam");
  await mkdir(dir, { recursive: true });
  await writeFile(activeRunPath(), JSON.stringify(state, null, 2));
}

export async function readActiveRun(): Promise<ActiveRunState | null> {
  try {
    const raw = await readFile(activeRunPath(), "utf8");
    return JSON.parse(raw) as ActiveRunState;
  } catch {
    return null;
  }
}

export async function clearActiveRun(): Promise<void> {
  try {
    await unlink(activeRunPath());
  } catch {
    // file may not exist — that is fine
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/unit/adw/ActiveRun.test.ts`
Expected: PASS — 4 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/adw/ActiveRun.ts tests/unit/adw/ActiveRun.test.ts
git commit -m "feat: add ActiveRun helpers for per-project run pause state"
```

---

## Task 3: Questions parser and answer formatter

**Files:**
- Create: `src/commands/spec-utils.ts`
- Create: `tests/unit/commands/spec-utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/commands/spec-utils.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { parseQuestionsFile, formatAnswers } from "../../../src/commands/spec-utils.js";

const SAMPLE_QUESTIONS = `## SCOPE
1. Who are the primary users and what task are they trying to complete?
2. What are the hard boundaries — what will this explicitly not do?

## CONSTRAINTS
3. Are there technology, platform, or timeline constraints to work within?

## SUCCESS
4. What does a successful outcome look like?
`;

describe("parseQuestionsFile", () => {
  it("parses categories and questions from markdown", () => {
    const result = parseQuestionsFile(SAMPLE_QUESTIONS);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("SCOPE");
    expect(result[0].questions).toHaveLength(2);
    expect(result[0].questions[0]).toBe("Who are the primary users and what task are they trying to complete?");
    expect(result[1].name).toBe("CONSTRAINTS");
    expect(result[1].questions).toHaveLength(1);
    expect(result[2].name).toBe("SUCCESS");
  });

  it("returns empty array for empty input", () => {
    expect(parseQuestionsFile("")).toEqual([]);
  });

  it("ignores lines that are not headings or numbered questions", () => {
    const result = parseQuestionsFile("Some preamble\n## SCOPE\n1. A question\nsome prose");
    expect(result[0].questions).toHaveLength(1);
  });
});

describe("formatAnswers", () => {
  it("produces markdown with category headings and Q&A pairs", () => {
    const categories = [
      { name: "SCOPE", questions: ["Who are the users?"] },
      { name: "SUCCESS", questions: ["What is done?"] },
    ];
    const answers = { SCOPE: ["Developers"], SUCCESS: ["Tests pass"] };
    const result = formatAnswers(answers, categories);
    expect(result).toContain("## SCOPE");
    expect(result).toContain("Who are the users?");
    expect(result).toContain("Developers");
    expect(result).toContain("## SUCCESS");
    expect(result).toContain("Tests pass");
  });

  it("uses placeholder when an answer is missing", () => {
    const categories = [{ name: "SCOPE", questions: ["Question one?"] }];
    const result = formatAnswers({}, categories);
    expect(result).toContain("(no answer)");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/unit/commands/spec-utils.test.ts`
Expected: FAIL — `spec-utils.js` not found

- [ ] **Step 3: Create `src/commands/spec-utils.ts`**

```typescript
export type QuestionCategory = {
  name: string;
  questions: string[];
};

export function parseQuestionsFile(text: string): QuestionCategory[] {
  const categories: QuestionCategory[] = [];
  let current: QuestionCategory | null = null;

  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      current = { name: heading[1].trim(), questions: [] };
      categories.push(current);
      continue;
    }
    const question = line.match(/^\d+\.\s+(.+)/);
    if (question && current) {
      current.questions.push(question[1].trim());
    }
  }

  return categories;
}

export function formatAnswers(
  answers: Record<string, string[]>,
  categories: QuestionCategory[],
): string {
  return categories
    .map(cat => {
      const catAnswers = answers[cat.name] ?? [];
      const lines = [`## ${cat.name}`, ""];
      cat.questions.forEach((q, i) => {
        lines.push(`${i + 1}. ${q}`);
        lines.push(`   Answer: ${catAnswers[i] ?? "(no answer)"}`);
        lines.push("");
      });
      return lines.join("\n");
    })
    .join("\n");
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/unit/commands/spec-utils.test.ts`
Expected: PASS — 5 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/commands/spec-utils.ts tests/unit/commands/spec-utils.test.ts
git commit -m "feat: add questions.md parser and answers.md formatter"
```

---

## Task 4: Engine pause support

**Files:**
- Modify: `src/adw/ADWEngine.ts`
- Modify: `tests/unit/adw/ADWEngine.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `tests/unit/adw/ADWEngine.test.ts` (after the last `it` block, inside the `describe`):

```typescript
  it("step with pauseAfter causes executeRun to return waiting_user", async () => {
    const dir = await makeTmpDir();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

    const pausingStep: Step = {
      name: "discover",
      required: true,
      pauseAfter: "answering",
      run: async (): Promise<StepResult> => ({ success: true, verdict: "PASS" }),
    };
    const nextStep = makePassStep("design");
    const workflow: Workflow = {
      name: "test-workflow",
      description: "test",
      steps: [pausingStep, nextStep],
      transitions: [
        { from: "discover", when: (r) => r.verdict === "PASS", to: "design" },
        { from: "discover", when: (r) => r.verdict !== "PASS", to: "halt" },
        { from: "design",   when: (_r) => true,                 to: "halt" },
      ],
      defaults: {},
    };
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });

    const run = await engine.startRun({ workflow: "test-workflow", goal: "test goal", budget: {} });
    const state = await engine.executeRun(run.runId);

    expect(state.status).toBe("waiting_user");
    expect(state.currentStep).toBe("design");

    cwdSpy.mockRestore();
  });

  it("executeUntilPause resumes from waiting_user and runs to next pause", async () => {
    const dir = await makeTmpDir();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

    const step1: Step = {
      name: "s1",
      required: true,
      pauseAfter: "approving",
      run: async (): Promise<StepResult> => ({ success: true, verdict: "PASS" }),
    };
    const step2 = makePassStep("s2");
    const workflow: Workflow = {
      name: "test-workflow",
      description: "test",
      steps: [step1, step2],
      transitions: [
        { from: "s1", when: (r) => r.verdict === "PASS", to: "s2" },
        { from: "s1", when: (r) => r.verdict !== "PASS", to: "halt" },
        { from: "s2", when: (_r) => true, to: "halt" },
      ],
      defaults: {},
    };
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });

    const run = await engine.startRun({ workflow: "test-workflow", goal: "test", budget: {} });
    const paused = await engine.executeRun(run.runId);
    expect(paused.status).toBe("waiting_user");

    const final = await engine.executeUntilPause(run.runId);
    expect(final.status).toBe("succeeded");

    cwdSpy.mockRestore();
  });
```

- [ ] **Step 2: Run tests to confirm the new tests fail**

Run: `npx vitest run tests/unit/adw/ADWEngine.test.ts`
Expected: FAIL — `pauseAfter` unknown property, `executeUntilPause` not a function

- [ ] **Step 3: Add import and pause logic to `src/adw/ADWEngine.ts`**

Add import at the top of `src/adw/ADWEngine.ts` (after existing imports):
```typescript
import { writeActiveRun } from "./ActiveRun.js";
```

After the transition update block (after `await saveRunState(this.config.runsDir, state);` inside the while loop, before the closing `}`), add:

```typescript
      // Pause if the completed step requested it
      if (stepDef.pauseAfter && result.verdict === "PASS") {
        state = { ...state, status: "waiting_user" };
        await writeActiveRun({
          runId,
          phase: stepDef.pauseAfter,
          stepName: stepDef.name,
          runsDir: this.config.runsDir,
        });
        await saveRunState(this.config.runsDir, state);
        break;
      }
```

The full modified block at the end of the while loop becomes:
```typescript
      if (!transition || transition.to === "halt") {
        state = { ...state, status: result.success ? "succeeded" : "failed" };
        break;
      }

      state = {
        ...state,
        currentStep: transition.to,
        iteration: state.iteration + 1,
      };

      await saveRunState(this.config.runsDir, state);

      // Pause if the completed step requested it
      if (stepDef.pauseAfter && result.verdict === "PASS") {
        state = { ...state, status: "waiting_user" };
        await writeActiveRun({
          runId,
          phase: stepDef.pauseAfter,
          stepName: stepDef.name,
          runsDir: this.config.runsDir,
        });
        await saveRunState(this.config.runsDir, state);
        break;
      }
    }
```

- [ ] **Step 4: Add `executeUntilPause` method to `ADWEngine` class**

Add after the `resumeRun` method (line ~203 in the current file):

```typescript
  async executeUntilPause(runId: string): Promise<RunState> {
    const state = await loadRunState(this.config.runsDir, runId);
    if (!state) throw new Error(`Run ${runId} not found`);
    if (state.status === "waiting_user") {
      await saveRunState(this.config.runsDir, { ...state, status: "running" });
    }
    return this.executeRun(runId);
  }
```

- [ ] **Step 5: Run all ADWEngine tests**

Run: `npx vitest run tests/unit/adw/ADWEngine.test.ts`
Expected: PASS — all 6 tests passing

- [ ] **Step 6: Run full suite to check for regressions**

Run: `npm test`
Expected: PASS — all existing tests still passing

- [ ] **Step 7: Commit**

```bash
git add src/adw/ADWEngine.ts tests/unit/adw/ADWEngine.test.ts
git commit -m "feat: add waiting_user pause logic and executeUntilPause to ADWEngine"
```

---

## Task 5: QuestionWizard TUI component

**Files:**
- Create: `src/ui/QuestionWizard.ts`
- Create: `tests/unit/ui/QuestionWizard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/ui/QuestionWizard.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { QuestionWizard } from "../../../src/ui/QuestionWizard.js";
import type { QuestionCategory } from "../../../src/commands/spec-utils.js";

function makeMockTui() {
  return { requestRender: vi.fn() } as any;
}

function makeMockTheme() {
  return { fg: (_color: string, text: string) => text } as any;
}

const CATEGORIES: QuestionCategory[] = [
  { name: "SCOPE", questions: ["Who are the users?", "What are the boundaries?"] },
  { name: "SUCCESS", questions: ["What does done look like?"] },
];

describe("QuestionWizard", () => {
  it("render() includes category tab names", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    const lines = wizard.render(80);
    const output = lines.join("\n");
    expect(output).toContain("SCOPE");
    expect(output).toContain("SUCCESS");
  });

  it("render() shows first category questions by default", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    const output = wizard.render(80).join("\n");
    expect(output).toContain("Who are the users?");
    expect(output).toContain("What are the boundaries?");
    expect(output).not.toContain("What does done look like?");
  });

  it("right arrow key switches to next tab", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    wizard.handleInput("\x1b[C"); // right arrow
    const output = wizard.render(80).join("\n");
    expect(output).toContain("What does done look like?");
    expect(output).not.toContain("Who are the users?");
  });

  it("left arrow does not go below tab 0", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    wizard.handleInput("\x1b[D"); // left arrow
    const output = wizard.render(80).join("\n");
    expect(output).toContain("Who are the users?"); // still on SCOPE
  });

  it("Ctrl+Enter with all fields empty does not call done", () => {
    const done = vi.fn();
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, done);
    wizard.handleInput("\x1b[13;5u"); // Ctrl+Enter (Kitty)
    expect(done).not.toHaveBeenCalled();
  });

  it("invalidate() does not throw", () => {
    const wizard = new QuestionWizard(makeMockTui(), makeMockTheme(), CATEGORIES, vi.fn());
    expect(() => wizard.invalidate()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/unit/ui/QuestionWizard.test.ts`
Expected: FAIL — `QuestionWizard.js` not found

- [ ] **Step 3: Create `src/ui/QuestionWizard.ts`**

```typescript
import { Input, matchesKey } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { QuestionCategory } from "../commands/spec-utils.js";

export type { QuestionCategory };

export class QuestionWizard implements Component {
  private activeTab = 0;
  private activeFocusIndex = 0;
  private readonly inputs: Input[][];
  private readonly validationErrors: boolean[][];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly categories: QuestionCategory[],
    private readonly done: (result: Record<string, string[]>) => void,
  ) {
    this.inputs = categories.map(cat => cat.questions.map(() => new Input()));
    this.validationErrors = categories.map(cat => cat.questions.map(() => false));
    this.syncFocus();
  }

  private syncFocus(): void {
    for (let t = 0; t < this.inputs.length; t++) {
      for (let q = 0; q < this.inputs[t].length; q++) {
        this.inputs[t][q].focused = t === this.activeTab && q === this.activeFocusIndex;
      }
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "right")) {
      this.activeTab = Math.min(this.activeTab + 1, this.categories.length - 1);
      this.activeFocusIndex = 0;
      this.syncFocus();
      return;
    }
    if (matchesKey(data, "left")) {
      this.activeTab = Math.max(this.activeTab - 1, 0);
      this.activeFocusIndex = 0;
      this.syncFocus();
      return;
    }
    if (matchesKey(data, "tab")) {
      const max = this.inputs[this.activeTab].length - 1;
      this.activeFocusIndex = this.activeFocusIndex >= max ? 0 : this.activeFocusIndex + 1;
      this.syncFocus();
      return;
    }
    if (matchesKey(data, "ctrl+enter")) {
      this.trySubmit();
      return;
    }
    this.inputs[this.activeTab][this.activeFocusIndex].handleInput(data);
    this.tui.requestRender();
  }

  private trySubmit(): void {
    let hasErrors = false;
    for (let t = 0; t < this.inputs.length; t++) {
      for (let q = 0; q < this.inputs[t].length; q++) {
        const empty = this.inputs[t][q].getValue().trim() === "";
        this.validationErrors[t][q] = empty;
        if (empty) hasErrors = true;
      }
    }
    this.tui.requestRender();
    if (hasErrors) return;

    const result: Record<string, string[]> = {};
    for (let t = 0; t < this.categories.length; t++) {
      result[this.categories[t].name] = this.inputs[t].map(inp => inp.getValue().trim());
    }
    this.done(result);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Tab bar — no outer border
    const tabBar = this.categories
      .map((cat, i) =>
        i === this.activeTab
          ? this.theme.fg("accent", ` ${cat.name} `)
          : this.theme.fg("muted", ` ${cat.name} `),
      )
      .join("  ");
    lines.push(tabBar);
    lines.push("");

    // Active category questions and inputs
    const cat = this.categories[this.activeTab];
    for (let q = 0; q < cat.questions.length; q++) {
      const hasError = this.validationErrors[this.activeTab][q];
      lines.push(this.theme.fg(hasError ? "error" : "muted", cat.questions[q]));
      lines.push(...this.inputs[this.activeTab][q].render(width));
      lines.push("");
    }

    lines.push(this.theme.fg("muted", "→/← category  Tab next field  Ctrl+Enter submit"));
    return lines;
  }

  invalidate(): void {
    for (const row of this.inputs) {
      for (const inp of row) {
        inp.invalidate();
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/unit/ui/QuestionWizard.test.ts`
Expected: PASS — 6 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/ui/QuestionWizard.ts tests/unit/ui/QuestionWizard.test.ts
git commit -m "feat: add QuestionWizard TUI component for discovery question input"
```

---

## Task 6: spec-plan-build-review workflow

**Files:**
- Create: `src/workflows/spec-plan-build-review.ts`
- Create: `tests/unit/workflows/spec-plan-build-review.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/workflows/spec-plan-build-review.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { specPlanBuildReview } from "../../../src/workflows/spec-plan-build-review.js";

describe("specPlanBuildReview workflow", () => {
  it("has the correct step order", () => {
    const names = specPlanBuildReview.steps.map(s => s.name);
    expect(names).toEqual(["discover", "design", "plan", "build", "review"]);
  });

  it("discover and design and plan steps have pauseAfter set", () => {
    const discover = specPlanBuildReview.steps.find(s => s.name === "discover")!;
    const design   = specPlanBuildReview.steps.find(s => s.name === "design")!;
    const plan     = specPlanBuildReview.steps.find(s => s.name === "plan")!;
    const build    = specPlanBuildReview.steps.find(s => s.name === "build")!;
    const review   = specPlanBuildReview.steps.find(s => s.name === "review")!;

    expect(discover.pauseAfter).toBe("answering");
    expect(design.pauseAfter).toBe("approving");
    expect(plan.pauseAfter).toBe("approving");
    expect(build.pauseAfter).toBeUndefined();
    expect(review.pauseAfter).toBeUndefined();
  });

  it("transitions PASS from discover→design→plan→build→review→halt", () => {
    const passResult = { success: true, verdict: "PASS" as const };
    const failResult = { success: false, verdict: "FAIL" as const };

    function findTransition(from: string, r: typeof passResult) {
      return specPlanBuildReview.transitions.find(t => t.from === from && t.when(r))?.to;
    }

    expect(findTransition("discover", passResult)).toBe("design");
    expect(findTransition("discover", failResult)).toBe("halt");
    expect(findTransition("design",   passResult)).toBe("plan");
    expect(findTransition("plan",     passResult)).toBe("build");
    expect(findTransition("build",    passResult)).toBe("review");
    expect(findTransition("review",   passResult)).toBe("halt");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/unit/workflows/spec-plan-build-review.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/workflows/spec-plan-build-review.ts`**

```typescript
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not emit verdict for ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(ctx.run.runId, stepName, (v: VerdictPayload) => {
      clearTimeout(timeout);
      resolve(v);
    });

    ctx.team.deliver(agentName, {
      id: crypto.randomUUID(),
      from: "system",
      to: agentName,
      summary: `Execute step: ${stepName}`,
      message: prompt,
      ts: new Date().toISOString(),
    }).catch(reject);
  });
}

const discoverStep: Step = {
  name: "discover",
  required: true,
  pauseAfter: "answering",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are gathering requirements for this feature goal:

GOAL: ${ctx.run.goal}

Write a questions.md file with 3-5 focused discovery questions in these exact categories: SCOPE, CONSTRAINTS, SUCCESS, CONTEXT.

Use this exact format:
## SCOPE
1. [question]

## CONSTRAINTS
2. [question]

## SUCCESS
3. [question]

## CONTEXT
4. [question]

Questions should be one sentence each. Save the file to questions.md in the current run directory.
Call VerdictEmit with step: "discover", verdict: "PASS", artifacts: ["questions.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "discoverer", prompt, "discover");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { questions: "questions.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const designStep: Step = {
  name: "design",
  required: true,
  pauseAfter: "approving",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are writing a feature specification.

GOAL: ${ctx.run.goal}

Read answers.md for the user's discovery answers. Write spec.md with these exact sections:
# Spec: [Feature Name]

## Problem
[What is broken or missing]

## Approach
[Chosen solution and why]

## Acceptance Criteria
- [Observable, testable outcome]

## Key Interfaces
[TypeScript types or prose describing public API shapes]

## Out of Scope
- [Explicit exclusions]

## Open Questions
- [Unresolved decisions to be made during implementation]

Be specific. No filler.
Call VerdictEmit with step: "design", verdict: "PASS", artifacts: ["spec.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "architect", prompt, "design");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { spec: "spec.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const planStep: Step = {
  name: "plan",
  required: true,
  pauseAfter: "approving",
  run: async (ctx: StepContext): Promise<StepResult> => {
    const specArtifact = ctx.run.artifacts["spec"] ?? "spec.md";
    const prompt = `You are writing an implementation plan.

GOAL: ${ctx.run.goal}
SPEC: ${specArtifact}

Read the spec file. Write plan.md with:
1. A file structure table: file path and its single responsibility
2. Checkbox tasks grouped by phase, each tagged [fast], [standard], or [reasoning]
   - fast: simple edits, field additions
   - standard: new modules, API calls, moderate logic
   - reasoning: architecture decisions, security-sensitive code

Format tasks as:
- [ ] [standard] Description — file: path/to/file.ts

Call VerdictEmit with step: "plan", verdict: "PASS", artifacts: ["plan.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "planner", prompt, "plan");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { plan: verdict.artifacts?.[0] ?? "plan.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const buildStep: Step = {
  name: "build",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["plan"] ?? "No plan artifact found";
    const prompt = `You are the implementer. Execute the plan:

PLAN LOCATION: ${planArtifact}

1. Read the plan file
2. Implement each task in order
3. Write tests alongside code (TDD)
4. For destructive operations (git push, npm install, file delete), call RequestApproval first

Call VerdictEmit with step: "build", verdict: "PASS" when implementation is complete and tests pass, or "FAIL" with specific issues listed.`;

    try {
      const verdict = await waitForVerdict(ctx, "implementer", prompt, "build");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const reviewStep: Step = {
  name: "review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the reviewer. Review the implementation for:

GOAL: ${ctx.run.goal}

Check all changed/created files for logical errors, missing tests, security issues, and spec compliance.
Call VerdictEmit with step: "review", verdict: "PASS" or "FAIL" with specific issues.
Set handoffHint: "security" | "perf" | "re-plan" if the failure category warrants specialist escalation.`;

    try {
      const verdict = await waitForVerdict(ctx, "reviewer", prompt, "review");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const specPlanBuildReview: Workflow = {
  name: "spec-plan-build-review",
  description: "Discover requirements, write spec, plan, build, and review.",
  steps: [discoverStep, designStep, planStep, buildStep, reviewStep],
  transitions: [
    { from: "discover", when: (r) => r.verdict === "PASS", to: "design" },
    { from: "discover", when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "design",   when: (r) => r.verdict === "PASS", to: "plan" },
    { from: "design",   when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "plan",     when: (r) => r.verdict === "PASS", to: "build" },
    { from: "plan",     when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "build",    when: (r) => r.verdict === "PASS", to: "review" },
    { from: "build",    when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "review",   when: (_r) => true,                to: "halt" },
  ],
  defaults: {
    maxIterations: 12,
    maxCostUsd: 30,
    maxWallSeconds: 7200,
  },
};
```

- [ ] **Step 4: Run workflow tests**

Run: `npx vitest run tests/unit/workflows/spec-plan-build-review.test.ts`
Expected: PASS — 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/workflows/spec-plan-build-review.ts tests/unit/workflows/spec-plan-build-review.test.ts
git commit -m "feat: add spec-plan-build-review workflow with 5 gated steps"
```

---

## Task 7: /spec command handler

**Files:**
- Create: `src/commands/spec.ts`

- [ ] **Step 1: Create `src/commands/spec.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { AgentDefinition } from "../types.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { clearActiveRun } from "../adw/ActiveRun.js";
import { QuestionWizard } from "../ui/QuestionWizard.js";
import { parseQuestionsFile, formatAnswers } from "./spec-utils.js";

export function registerSpecCommand(
  pi: ExtensionAPI,
  engine: ADWEngine,
  team: TeamRuntime,
  agentDefs: AgentDefinition[],
  runsDir: string,
): void {
  pi.registerCommand("spec", {
    description:
      "Discover requirements, write spec and plan, then build and review. Usage: /spec <goal>",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify(
          'Usage: /spec <goal in plain English>\nExample: /spec "Add dark mode toggle to settings"',
          "error",
        );
        return;
      }

      // Ensure all agents are started
      for (const def of agentDefs) {
        await team.ensureTeammate(def.name, def);
      }

      const run = await engine.startRun({
        workflow: "spec-plan-build-review",
        goal,
        budget: {},
      });

      ctx.ui.notify(
        `▶ spec-plan-build-review started (run ${run.runId.slice(0, 8)})\nGoal: ${goal}\nDiscovering requirements…`,
        "info",
      );

      // Phase 1: run until discover step pauses awaiting wizard input
      await engine.executeUntilPause(run.runId);

      // Read questions.md written by the discoverer
      const questionsPath = join(runsDir, run.runId, "questions.md");
      let questionsRaw: string;
      try {
        questionsRaw = await readFile(questionsPath, "utf8");
      } catch {
        ctx.ui.notify("Discoverer did not write questions.md. Run aborted.", "error");
        await engine.abortRun(run.runId);
        return;
      }

      const categories = parseQuestionsFile(questionsRaw);
      if (categories.length === 0) {
        ctx.ui.notify("No questions found in questions.md. Run aborted.", "error");
        await engine.abortRun(run.runId);
        return;
      }

      // Show TUI wizard — blocks until user submits
      const answers = await ctx.ui.custom<Record<string, string[]>>(
        (tui, theme, _keybindings, done) => new QuestionWizard(tui, theme, categories, done),
        {
          overlay: true,
          overlayOptions: { width: "80%", maxHeight: "90%", anchor: "top-center", offsetY: 1 },
        },
      );

      // Write answers.md
      const runDir = join(runsDir, run.runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "answers.md"), formatAnswers(answers, categories));

      // Clear the answering phase marker
      await clearActiveRun();

      // Phase 2: resume — runs until design step pauses awaiting approval
      await engine.executeUntilPause(run.runId);

      const specPath = join(runsDir, run.runId, "spec.md");
      ctx.ui.notify(
        `spec written → ${specPath}\n\nReview the spec, then type "approve" when ready to write the plan.`,
        "info",
      );
      // Command returns. The input hook takes over for approval phases.
    },
  });
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS — no regressions

- [ ] **Step 4: Commit**

```bash
git add src/commands/spec.ts
git commit -m "feat: add /spec command handler with TUI wizard and phase-gated resume"
```

---

## Task 8: Wire up in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add discoverer and architect agent definitions**

In `src/index.ts`, after the `reviewer` entry in `AGENT_DEFS`, add:

```typescript
  {
    name: "discoverer",
    description: "Generates discovery questions to understand feature requirements before spec writing",
    model: "claude-haiku-4-5-20251001",
    systemPrompt:
      "You are the Discoverer agent for the pi-engteam engineering team. " +
      "Analyze the feature goal and write 3-5 focused discovery questions in a questions.md file. " +
      "Categories must be exactly: SCOPE, CONSTRAINTS, SUCCESS, CONTEXT. " +
      "Use numbered lists under each ## heading. Keep each question to one sentence. " +
      "Always call VerdictEmit at the end of your turn.",
  },
  {
    name: "architect",
    description: "Writes feature specifications from goals and answered discovery questions",
    model: "claude-opus-4-6",
    systemPrompt:
      "You are the Architect agent for the pi-engteam engineering team. " +
      "Read the discovery answers and write a precise, complete feature specification in spec.md. " +
      "Use the ADR-style sections: Problem, Approach, Acceptance Criteria, Key Interfaces, Out of Scope, Open Questions. " +
      "Be specific — no padding or vague statements. " +
      "Always call VerdictEmit at the end of your turn.",
  },
```

- [ ] **Step 2: Import and register the workflow**

Add import near the top of `src/index.ts` (after the existing workflow imports):
```typescript
import { specPlanBuildReview } from "./workflows/spec-plan-build-review.js";
```

Add to the `workflows` Map (after the `"doc-backfill"` entry):
```typescript
    ["spec-plan-build-review", specPlanBuildReview],
```

- [ ] **Step 3: Import and register the /spec command**

Add import near the top of `src/index.ts` (after the existing command imports):
```typescript
import { registerSpecCommand } from "./commands/spec.js";
```

Add registration call after `registerWorkflowShortcuts(pi, engine)`:
```typescript
  registerSpecCommand(pi, engine, team, AGENT_DEFS, RUNS_DIR);
```

- [ ] **Step 4: Register the input hook for approval gates**

Add at the end of the `export default async function (pi: ExtensionAPI)` body, after all `registerXxx` calls:

```typescript
  // Input hook: handles "approve" keywords during waiting_user phases
  pi.on("input", async (event, ctx) => {
    const { readActiveRun, clearActiveRun } = await import("./adw/ActiveRun.js");
    const activeRun = await readActiveRun();
    if (!activeRun || activeRun.phase !== "approving") return { action: "continue" as const };

    const text = event.text.toLowerCase().trim();
    const isApproval = text === "approve" || text === "approved" || text.includes("looks good");

    if (!isApproval) {
      ctx.ui.notify('Type "approve" when you are ready to continue.', "info");
      return { action: "handled" as const };
    }

    const { runId, stepName } = activeRun;
    await clearActiveRun();

    const stepAckMessages: Record<string, string> = {
      design: "Approved. Running planner…",
      plan: "Approved. Starting build…",
    };
    ctx.ui.notify(stepAckMessages[stepName] ?? "Approved. Resuming…", "info");

    void engine.executeUntilPause(runId).then(state => {
      if (state.status === "waiting_user") {
        readActiveRun().then(ar => {
          if (ar?.stepName === "plan") {
            ctx.ui.notify(
              `plan written → ${join(RUNS_DIR, runId, "plan.md")}\n\nReview the plan, then type "approve" when ready to build.`,
              "info",
            );
          }
        });
      } else if (state.status === "succeeded") {
        ctx.ui.notify("✓ Workflow complete.", "info");
      } else if (state.status === "failed") {
        ctx.ui.notify(`Workflow stopped: step ${state.currentStep} failed.`, "error");
      }
    });

    return { action: "handled" as const };
  });
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS — all tests passing

- [ ] **Step 7: Build the extension**

Run: `npm run build`
Expected: PASS — `dist/extension.js` produced without errors

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire spec-plan-build-review workflow, /spec command, and approval input hook into extension"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `/spec "goal"` starts workflow | Task 7 + 8 |
| Discoverer writes questions.md | Task 6 (discoverStep) |
| TUI wizard, no outer border, tabs, Tab/→/←/Ctrl+Enter | Task 5 |
| answers.md written after wizard | Task 7 |
| Architect writes spec.md, engine pauses | Task 6 (designStep) |
| Planner writes plan.md with tier hints, engine pauses | Task 6 (planStep) |
| User types "approve" → input hook resumes | Task 8 (input hook) |
| active-run.json in CWD, not global | Task 2 |
| executeUntilPause method | Task 4 |
| `/plan` unchanged | Not modified — ✓ |
| Two simultaneous projects don't collide | Task 2 (per-cwd path) |

**No placeholder patterns found** — all code is complete.

**Type consistency:** `QuestionCategory` exported from `spec-utils.ts` and re-exported from `QuestionWizard.ts`. `ActiveRunState` used consistently in engine and command. `waiting_user` added to `RunStatus` type referenced by engine.
