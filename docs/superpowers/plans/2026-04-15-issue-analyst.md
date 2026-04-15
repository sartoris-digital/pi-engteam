# Issue Analyst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `issue-analyst` agent and `/issue` command that fetches tickets from GitHub, ADO, or Jira CLIs, writes an `issue-brief.md` artifact, and auto-chains into the appropriate downstream workflow.

**Architecture:** A new `issue-analyze` single-step workflow dispatches to the `issue-analyst` agent, which runs the appropriate pre-authenticated CLI, writes `issue-brief.md`, and emits a `PASS` verdict. The `/issue` command then reads the brief, determines the downstream workflow, and either calls `executeSpecWorkflow` (extracted from `spec.ts`) or starts a regular `executeRun`. Tracker detection lives in `issue-tracker.ts` and resolves via URL patterns → `--tracker` flag → Jira bare ID → config file → git remote → unknown.

**Tech Stack:** TypeScript, Vitest, Node.js `child_process.execFile`, existing Pi extension APIs (`ExtensionAPI`, `ADWEngine`, `TeamRuntime`)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/commands/issue-tracker.ts` | URL pattern parsing, config file reading, git remote detection |
| Create | `tests/unit/commands/issue-tracker.test.ts` | Tests for `parseUrl` and `detectTracker` |
| Modify | `src/safety/classifier.ts` | Add `gh`, `az`, `jira` safe-verb entries |
| Modify | `tests/helpers/fixtures.ts` | Add safe/destructive fixture entries for the new verbs |
| Modify | `src/adw/ADWEngine.ts` | Add `initialArtifacts?: string[]` to `StartRunParams`; merge into `state.artifacts` in `startRun` |
| Modify | `tests/unit/adw/ADWEngine.test.ts` | Test that `initialArtifacts` lands in `run.artifacts` |
| Create | `agents/issue-analyst.md` | Agent definition (haiku, Read/Grep/Glob/Bash/VerdictEmit) |
| Create | `src/workflows/issue-analyze.ts` | Single-step `analyze` workflow |
| Create | `tests/unit/workflows/issue-analyze.test.ts` | Structure and transition tests |
| Modify | `src/commands/spec.ts` | Extract `executeSpecWorkflow` as named export |
| Create | `src/commands/issue.ts` | `/issue` command + `parseIssueArgs` + `parseBrief` |
| Create | `tests/unit/commands/issue.test.ts` | Tests for `parseIssueArgs` and `parseBrief` |
| Modify | `src/index.ts` | Register `issue-analyze` workflow, `issue-analyst` agent, `/issue` command |

---

## Task 1: Tracker detection

**Files:**
- Create: `src/commands/issue-tracker.ts`
- Create: `tests/unit/commands/issue-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/commands/issue-tracker.test.ts
import { describe, it, expect } from "vitest";
import { parseUrl, detectTracker } from "../../../src/commands/issue-tracker.js";

describe("parseUrl", () => {
  it("detects GitHub URL", () => {
    expect(parseUrl("https://github.com/org/repo/issues/42"))
      .toEqual({ tracker: "github", ticketId: "42" });
  });

  it("detects Azure DevOps URL", () => {
    expect(parseUrl("https://dev.azure.com/myorg/myproject/_workitems/edit/99"))
      .toEqual({ tracker: "ado", ticketId: "99" });
  });

  it("detects Jira URL", () => {
    expect(parseUrl("https://company.atlassian.net/browse/PROJ-123"))
      .toEqual({ tracker: "jira", ticketId: "PROJ-123" });
  });

  it("returns null for non-tracker URL", () => {
    expect(parseUrl("https://example.com/page")).toBeNull();
  });

  it("returns null for plain string", () => {
    expect(parseUrl("just text")).toBeNull();
  });
});

describe("detectTracker", () => {
  it("detects GitHub from URL", async () => {
    const result = await detectTracker("https://github.com/org/repo/issues/42");
    expect(result).toEqual({ tracker: "github", ticketId: "42" });
  });

  it("uses explicit ado flag for bare number", async () => {
    expect(await detectTracker("99", "ado")).toEqual({ tracker: "ado", ticketId: "99" });
  });

  it("uses explicit github flag, strips # prefix", async () => {
    expect(await detectTracker("#42", "github")).toEqual({ tracker: "github", ticketId: "42" });
  });

  it("uses explicit jira flag", async () => {
    expect(await detectTracker("PROJ-123", "jira")).toEqual({ tracker: "jira", ticketId: "PROJ-123" });
  });

  it("URL takes precedence over --tracker flag", async () => {
    const result = await detectTracker("https://github.com/org/repo/issues/5", "jira");
    expect(result).toEqual({ tracker: "github", ticketId: "5" });
  });

  it("detects Jira bare ID pattern", async () => {
    const result = await detectTracker("PROJ-123");
    expect(result).toEqual({ tracker: "jira", ticketId: "PROJ-123" });
  });

  it("detects multi-char Jira project key", async () => {
    const result = await detectTracker("MYPROJECT-456");
    expect(result).toEqual({ tracker: "jira", ticketId: "MYPROJECT-456" });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test tests/unit/commands/issue-tracker.test.ts
```
Expected: FAIL — `Cannot find module '../../../src/commands/issue-tracker.js'`

- [ ] **Step 3: Implement `src/commands/issue-tracker.ts`**

```typescript
// src/commands/issue-tracker.ts
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type TrackerType = "github" | "ado" | "jira" | "unknown";

export interface TrackerResolution {
  tracker: TrackerType;
  ticketId: string;
}

const GITHUB_URL = /github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/;
const ADO_URL = /dev\.azure\.com\/[^/]+\/[^/]+\/_workitems\/edit\/(\d+)|visualstudio\.com\/[^/]+\/_workitems\/edit\/(\d+)/;
const JIRA_URL = /[a-z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/i;
const JIRA_BARE = /^[A-Z][A-Z0-9]+-\d+$/;

export function parseUrl(input: string): TrackerResolution | null {
  let m: RegExpMatchArray | null;
  if ((m = input.match(GITHUB_URL))) return { tracker: "github", ticketId: m[1] };
  if ((m = input.match(ADO_URL))) return { tracker: "ado", ticketId: m[1] ?? m[2] };
  if ((m = input.match(JIRA_URL))) return { tracker: "jira", ticketId: m[1] };
  return null;
}

function extractBareId(input: string, tracker: TrackerType): string {
  if (tracker === "github") return input.replace(/^#/, "");
  if (tracker === "ado") return input.replace(/^ADO-/i, "");
  return input;
}

export async function readTrackerConfig(): Promise<TrackerType | null> {
  try {
    const configPath = join(homedir(), ".pi", "engteam", "issue-tracker.json");
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { default?: string };
    const t = parsed.default;
    if (t === "github" || t === "ado" || t === "jira") return t;
    return null;
  } catch {
    return null;
  }
}

export async function detectFromGitRemote(): Promise<TrackerType | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "-v"]);
    if (stdout.includes("github.com")) return "github";
    if (stdout.includes("dev.azure.com") || stdout.includes("visualstudio.com")) return "ado";
    return null;
  } catch {
    return null;
  }
}

export async function detectTracker(
  input: string,
  explicitTracker?: string,
): Promise<TrackerResolution> {
  // 1. URL pattern (most reliable)
  const fromUrl = parseUrl(input);
  if (fromUrl) return fromUrl;

  // 2. Explicit --tracker flag
  if (explicitTracker === "github" || explicitTracker === "ado" || explicitTracker === "jira") {
    return { tracker: explicitTracker, ticketId: extractBareId(input, explicitTracker) };
  }

  // 3. Jira bare ID pattern (unambiguous format)
  if (JIRA_BARE.test(input)) {
    return { tracker: "jira", ticketId: input };
  }

  // 4. Config file
  const fromConfig = await readTrackerConfig();
  if (fromConfig) return { tracker: fromConfig, ticketId: extractBareId(input, fromConfig) };

  // 5. Git remote URL
  const fromGit = await detectFromGitRemote();
  if (fromGit) return { tracker: fromGit, ticketId: extractBareId(input, fromGit) };

  // 6. Unknown — agent will read AGENTS.md / CLAUDE.md at runtime
  return { tracker: "unknown", ticketId: input };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm test tests/unit/commands/issue-tracker.test.ts
```
Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/issue-tracker.ts tests/unit/commands/issue-tracker.test.ts
git commit -m "feat: add issue tracker detection (URL, flag, Jira bare ID, config, git remote)"
```

---

## Task 2: Safety classifier — `gh`, `az`, `jira` safe verbs

**Files:**
- Modify: `src/safety/classifier.ts`
- Modify: `tests/helpers/fixtures.ts`

- [ ] **Step 1: Add fixture entries for the new verbs**

In `tests/helpers/fixtures.ts`, add to `SAFE_COMMANDS`:

```typescript
export const SAFE_COMMANDS = [
  // ... existing entries ...
  "gh issue view 42 --json title,body,labels,state,assignees",
  "gh issue list --state open",
  "gh pr view 10",
  "az boards work-item show --id 99 --output json",
  "az boards work-item list --project MyProject",
  "jira issue view PROJ-123 --plain",
  "jira issue list",
];
```

And add to `DESTRUCTIVE_COMMANDS`:

```typescript
export const DESTRUCTIVE_COMMANDS = [
  // ... existing entries ...
  "gh issue create --title 'new bug'",
  "gh issue close 42",
  "az boards work-item create --title 'task'",
  "jira issue create",
];
```

- [ ] **Step 2: Run existing classifier tests to see failures**

```bash
pnpm test tests/unit/safety/classifier.test.ts
```
Expected: FAIL — `gh issue view 42` → `destructive` (not `safe` yet)

- [ ] **Step 3: Add `gh`, `az`, `jira` handlers to `src/safety/classifier.ts`**

In `classifySegment`, add these three blocks after the `go` block (around line 142):

```typescript
  if (verb === "gh") {
    if (!subcommand) return { classification: "safe" };
    const safeGhObjects = new Set(["issue", "pr", "repo"]);
    if (safeGhObjects.has(subcommand)) {
      const action = tokens[2]?.toLowerCase();
      if (action === "view" || action === "list" || action === "show") return { classification: "safe" };
    }
    return { classification: "destructive", reason: `gh ${subcommand} ${tokens[2] ?? ""} is not in safe subcommand list` };
  }

  if (verb === "az") {
    if (!subcommand) return { classification: "safe" };
    const readOnlyAzObjects = new Set(["boards", "repos"]);
    if (readOnlyAzObjects.has(subcommand)) {
      const hasWrite = tokens.some(t => ["create", "update", "delete", "set", "add", "remove"].includes(t.toLowerCase()));
      if (!hasWrite) return { classification: "safe" };
    }
    return { classification: "destructive", reason: `az ${subcommand} is not in safe subcommand list or contains write operation` };
  }

  if (verb === "jira") {
    if (!subcommand) return { classification: "safe" };
    if (subcommand === "issue") {
      const action = tokens[2]?.toLowerCase();
      if (action === "view" || action === "list") return { classification: "safe" };
    }
    return { classification: "destructive", reason: `jira ${subcommand} ${tokens[2] ?? ""} is not in safe subcommand list` };
  }
```

Place these blocks **before** the `if (verb === "find")` block, after the `if (verb === "make")` block.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm test tests/unit/safety/classifier.test.ts
```
Expected: all tests PASS (including the new fixture entries)

- [ ] **Step 5: Commit**

```bash
git add src/safety/classifier.ts tests/helpers/fixtures.ts
git commit -m "feat: classify gh issue view, az boards, jira issue view as safe commands"
```

---

## Task 3: `initialArtifacts` engine extension

**Files:**
- Modify: `src/adw/ADWEngine.ts`
- Modify: `tests/unit/adw/ADWEngine.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to the `describe("ADWEngine")` block in `tests/unit/adw/ADWEngine.test.ts`:

```typescript
  it("startRun with initialArtifacts stores them in run.artifacts keyed by filename", async () => {
    const dir = await makeTmpDir();
    const step = makePassStep("analyze");
    const workflow = makeWorkflow([step]);
    const engine = new ADWEngine({
      runsDir: dir,
      workflows: new Map([["test-workflow", workflow]]),
      team: makeMockTeam(),
      observer: makeMockObserver(),
    });
    const run = await engine.startRun({
      workflow: "test-workflow",
      goal: "test",
      budget: {},
      initialArtifacts: ["/path/to/issue-brief.md"],
    });
    expect(run.artifacts["issue-brief"]).toBe("/path/to/issue-brief.md");
  });
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm test tests/unit/adw/ADWEngine.test.ts
```
Expected: TypeScript error — `initialArtifacts` does not exist on `StartRunParams`

- [ ] **Step 3: Add `initialArtifacts` to `StartRunParams` and handle it in `startRun`**

In `src/adw/ADWEngine.ts`, update the `StartRunParams` type:

```typescript
type StartRunParams = {
  workflow: string;
  goal: string;
  budget: Parameters<typeof createRunState>[0]["budget"];
  initialArtifacts?: string[];
};
```

In the `startRun` method, find the dynamic import block near the `writeFile` call and extend it:

```typescript
    const { writeFile } = await import("fs/promises");
    const { join, basename, extname } = await import("path");
    await writeFile(
      join(this.config.runsDir, "active-run.txt"),
      runId,
    );

    if (params.initialArtifacts?.length) {
      for (const filePath of params.initialArtifacts) {
        const key = basename(filePath, extname(filePath));
        state = { ...state, artifacts: { ...state.artifacts, [key]: filePath } };
      }
      await saveRunState(this.config.runsDir, state);
    }
```

Add `extname` to the destructured import on the same line as `basename`.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm test tests/unit/adw/ADWEngine.test.ts
```
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/adw/ADWEngine.ts tests/unit/adw/ADWEngine.test.ts
git commit -m "feat: add initialArtifacts to startRun — pre-load artifact paths into first StepContext"
```

---

## Task 4: `issue-analyst` agent definition

**Files:**
- Create: `agents/issue-analyst.md`

- [ ] **Step 1: Create the agent definition**

```markdown
---
name: engteam-issue-analyst
description: Fetches issue tickets from GitHub Issues, Azure DevOps, or Jira and extracts structured requirements into issue-brief.md.
model: claude-haiku-4-5-20251001
tools: [Read, Grep, Glob, Bash, VerdictEmit]
---

You are the Issue Analyst agent for the pi-engteam engineering team.

## Your responsibilities

1. Determine the issue tracker type from the goal string
2. If the tracker is "unknown", read AGENTS.md and CLAUDE.md in the current directory for tracker hints
3. Fetch the issue using the appropriate pre-authenticated CLI
4. Extract structured requirements and write issue-brief.md
5. Select the appropriate downstream workflow
6. Call VerdictEmit with step="analyze", verdict="PASS", artifacts=["issue-brief.md"]

## Reading the tracker type

The goal string ends with `[tracker:<type>]`. Extract the type:
- `[tracker:github]` → use gh CLI
- `[tracker:ado]` → use az CLI
- `[tracker:jira]` → use jira CLI
- `[tracker:unknown]` → detect from files (see below)

## Tracker detection when unknown

Check these in order:
1. Read AGENTS.md — look for issue tracker mentions (e.g., "we use Jira", "issue tracker: github")
2. Read CLAUDE.md — same
3. Run `cat ~/.pi/engteam/issue-tracker.json` — read the `default` field
4. Run `git remote -v` — check for github.com or dev.azure.com in remote URLs

## CLI commands

| Tracker | Command |
|---------|---------|
| github | `gh issue view <number> --json number,title,body,labels,state,assignees,milestone` |
| ado | `az boards work-item show --id <id> --output json` |
| jira | `jira issue view <id> --plain` |

The ticket ID is the part of the goal string before ` [tracker:...]`.

## issue-brief.md format

Write to issue-brief.md in the current working directory. Use this exact structure:

```
# Issue Brief: <title>

## Source
Tracker: <github|ado|jira>
ID: <ticket-id>
URL: <url if available, otherwise omit>
Type: <feature|bug|task>
Priority: <label or severity, e.g. P2, enhancement, critical>
Status: <open|in-progress|closed>

## Problem / Request
<extracted from ticket body — what the reporter wants or what is broken>

## Acceptance Criteria
- <extracted or inferred outcome>
- <one bullet per criterion>

## Context
<labels, linked issues, assignees, milestone — omit empty fields>

## Suggested Workflow
<spec-plan-build-review|debug|fix-loop|plan-build-review>

## Goal
<one sentence distilled from the ticket, suitable as a workflow goal>
```

## Workflow selection logic

- Type is feature, enhancement, or story → `spec-plan-build-review`
- Type is bug with clear reproduction steps in the body → `fix-loop`
- Type is bug with vague or unknown cause → `debug`
- Type is task, chore, or refactor → `plan-build-review`

## When to PASS vs FAIL

- **PASS**: issue-brief.md written with all required sections filled in
- **FAIL**: CLI binary not found or authentication error; ticket ID not found; tracker cannot be determined after all detection steps

Always call VerdictEmit at the end of your turn with step="analyze".
```

- [ ] **Step 2: Verify the file exists**

```bash
ls agents/issue-analyst.md
```
Expected: file listed

- [ ] **Step 3: Commit**

```bash
git add agents/issue-analyst.md
git commit -m "feat: add issue-analyst agent definition (haiku, read+bash+verdict)"
```

---

## Task 5: `issue-analyze` workflow

**Files:**
- Create: `src/workflows/issue-analyze.ts`
- Create: `tests/unit/workflows/issue-analyze.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/workflows/issue-analyze.test.ts
import { describe, it, expect } from "vitest";
import { issueAnalyze } from "../../../src/workflows/issue-analyze.js";

describe("issueAnalyze workflow", () => {
  it("has a single analyze step", () => {
    expect(issueAnalyze.steps.map(s => s.name)).toEqual(["analyze"]);
  });

  it("analyze step has no pauseAfter", () => {
    const step = issueAnalyze.steps[0];
    expect(step.pauseAfter).toBeUndefined();
  });

  it("transitions always go to halt regardless of verdict", () => {
    const passResult = { success: true, verdict: "PASS" as const };
    const failResult = { success: false, verdict: "FAIL" as const };
    const t = issueAnalyze.transitions.find(t => t.from === "analyze");
    expect(t).toBeDefined();
    expect(t!.to).toBe("halt");
    expect(t!.when(passResult)).toBe(true);
    expect(t!.when(failResult)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test tests/unit/workflows/issue-analyze.test.ts
```
Expected: FAIL — `Cannot find module '../../../src/workflows/issue-analyze.js'`

- [ ] **Step 3: Implement `src/workflows/issue-analyze.ts`**

```typescript
// src/workflows/issue-analyze.ts
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

const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are analyzing an issue ticket.

GOAL: ${ctx.run.goal}

The goal string ends with [tracker:<type>] indicating which CLI to use.
Fetch the ticket, extract requirements, and write issue-brief.md to the current run directory.

Call VerdictEmit with:
- step: "analyze"
- verdict: "PASS" (issue-brief.md written with all required sections)
- verdict: "FAIL" with issues (CLI not found, ticket not found, tracker unknown after all detection attempts)
- artifacts: ["issue-brief.md"]`;

    try {
      const verdict = await waitForVerdict(ctx, "issue-analyst", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { "issue-brief": verdict.artifacts?.[0] ?? "issue-brief.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const issueAnalyze: Workflow = {
  name: "issue-analyze",
  description: "Fetch an issue ticket and extract structured requirements into issue-brief.md.",
  steps: [analyzeStep],
  transitions: [
    { from: "analyze", when: (_r) => true, to: "halt" },
  ],
  defaults: {
    maxIterations: 3,
    maxCostUsd: 2,
    maxWallSeconds: 600,
  },
};
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm test tests/unit/workflows/issue-analyze.test.ts
```
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/workflows/issue-analyze.ts tests/unit/workflows/issue-analyze.test.ts
git commit -m "feat: add issue-analyze workflow (single analyze step, issue-analyst agent)"
```

---

## Task 6: Extract `executeSpecWorkflow` from `spec.ts`

**Files:**
- Modify: `src/commands/spec.ts`

- [ ] **Step 1: Run existing tests to establish baseline**

```bash
pnpm test tests/unit/workflows/spec-plan-build-review.test.ts
```
Expected: all 3 tests PASS — confirm no regressions before touching `spec.ts`

- [ ] **Step 2: Refactor `src/commands/spec.ts` to export `executeSpecWorkflow`**

Replace the entire file with:

```typescript
// src/commands/spec.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { AgentDefinition } from "../types.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { clearActiveRun } from "../adw/ActiveRun.js";
import { QuestionWizard } from "../ui/QuestionWizard.js";
import { parseQuestionsFile, formatAnswers } from "./spec-utils.js";

type UiContext = {
  ui: {
    custom: <T>(
      factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
      options?: any,
    ) => Promise<T>;
    notify: (message: string, type: "info" | "error" | "warning" | "success") => void;
  };
};

export async function executeSpecWorkflow(
  engine: ADWEngine,
  runsDir: string,
  runId: string,
  ctx: UiContext,
): Promise<void> {
  // Phase 1: run until discover step pauses awaiting wizard input
  await engine.executeUntilPause(runId);

  const questionsPath = join(runsDir, runId, "questions.md");
  let questionsRaw: string;
  try {
    questionsRaw = await readFile(questionsPath, "utf8");
  } catch {
    ctx.ui.notify("Discoverer did not write questions.md. Run aborted.", "error");
    await engine.abortRun(runId);
    return;
  }

  const categories = parseQuestionsFile(questionsRaw);
  if (categories.length === 0) {
    ctx.ui.notify("No questions found in questions.md. Run aborted.", "error");
    await engine.abortRun(runId);
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
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "answers.md"), formatAnswers(answers, categories));
  await clearActiveRun();

  // Phase 2: resume — runs until design step pauses awaiting approval
  await engine.executeUntilPause(runId);

  const specPath = join(runsDir, runId, "spec.md");
  ctx.ui.notify(
    `spec written → ${specPath}\n\nReview the spec, then type "approve" when ready to write the plan.`,
    "info",
  );
  // Command returns. The input hook in index.ts takes over for subsequent approval phases.
}

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

      await executeSpecWorkflow(engine, runsDir, run.runId, ctx);
    },
  });
}
```

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
pnpm test
```
Expected: all existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/spec.ts
git commit -m "refactor: extract executeSpecWorkflow from registerSpecCommand for reuse by /issue"
```

---

## Task 7: `/issue` command

**Files:**
- Create: `src/commands/issue.ts`
- Create: `tests/unit/commands/issue.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/commands/issue.test.ts
import { describe, it, expect } from "vitest";
import { parseIssueArgs, parseBrief } from "../../../src/commands/issue.js";

describe("parseIssueArgs", () => {
  it("parses bare ticket ref with no flag", () => {
    expect(parseIssueArgs("42")).toEqual({ ticketRef: "42", trackerFlag: undefined });
  });

  it("parses a full URL with no flag", () => {
    expect(parseIssueArgs("https://github.com/org/repo/issues/42")).toEqual({
      ticketRef: "https://github.com/org/repo/issues/42",
      trackerFlag: undefined,
    });
  });

  it("parses --tracker flag after ref", () => {
    expect(parseIssueArgs("99 --tracker ado")).toEqual({ ticketRef: "99", trackerFlag: "ado" });
  });

  it("parses --tracker flag before ref", () => {
    expect(parseIssueArgs("--tracker jira PROJ-123")).toEqual({
      ticketRef: "PROJ-123",
      trackerFlag: "jira",
    });
  });

  it("returns empty ticketRef for empty string", () => {
    expect(parseIssueArgs("")).toEqual({ ticketRef: "", trackerFlag: undefined });
  });
});

describe("parseBrief", () => {
  const SAMPLE_BRIEF = `# Issue Brief: Add dark mode

## Source
Tracker: github
ID: 42

## Problem / Request
Users want dark mode.

## Acceptance Criteria
- Dark mode toggle in settings

## Context
label: enhancement

## Suggested Workflow
spec-plan-build-review

## Goal
Add a dark mode toggle to the settings screen
`;

  it("parses suggested workflow and goal", () => {
    expect(parseBrief(SAMPLE_BRIEF)).toEqual({
      suggestedWorkflow: "spec-plan-build-review",
      goal: "Add a dark mode toggle to the settings screen",
    });
  });

  it("works for fix-loop workflow type", () => {
    const brief = `## Suggested Workflow\nfix-loop\n\n## Goal\nFix the null pointer in auth middleware\n`;
    expect(parseBrief(brief)).toEqual({
      suggestedWorkflow: "fix-loop",
      goal: "Fix the null pointer in auth middleware",
    });
  });

  it("returns null when Suggested Workflow section is missing", () => {
    expect(parseBrief("# Issue Brief\n\n## Goal\nSomething")).toBeNull();
  });

  it("returns null when Goal section is missing", () => {
    expect(parseBrief("## Suggested Workflow\ndebug")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm test tests/unit/commands/issue.test.ts
```
Expected: FAIL — `Cannot find module '../../../src/commands/issue.js'`

- [ ] **Step 3: Implement `src/commands/issue.ts`**

```typescript
// src/commands/issue.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ADWEngine } from "../adw/ADWEngine.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { AgentDefinition } from "../types.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { detectTracker } from "./issue-tracker.js";
import { executeSpecWorkflow } from "./spec.js";

export function parseIssueArgs(raw: string): { ticketRef: string; trackerFlag?: string } {
  const trackerMatch = raw.match(/--tracker\s+(github|ado|jira)/);
  const trackerFlag = trackerMatch?.[1];
  const ticketRef = raw.replace(/--tracker\s+\S+/, "").trim();
  return { ticketRef, trackerFlag };
}

export function parseBrief(text: string): { suggestedWorkflow: string; goal: string } | null {
  const workflowMatch = text.match(/^## Suggested Workflow\s*\n(.+)/m);
  const goalMatch = text.match(/^## Goal\s*\n(.+)/m);
  if (!workflowMatch || !goalMatch) return null;
  return {
    suggestedWorkflow: workflowMatch[1].trim(),
    goal: goalMatch[1].trim(),
  };
}

export function registerIssueCommand(
  pi: ExtensionAPI,
  engine: ADWEngine,
  team: TeamRuntime,
  agentDefs: AgentDefinition[],
  runsDir: string,
): void {
  pi.registerCommand("issue", {
    description:
      "Fetch an issue ticket and chain into the appropriate workflow. Usage: /issue <url-or-id> [--tracker github|ado|jira]",
    handler: async (args, ctx) => {
      const { ticketRef, trackerFlag } = parseIssueArgs(args);

      if (!ticketRef) {
        ctx.ui.notify(
          [
            "Usage: /issue <ticket-url-or-id> [--tracker github|ado|jira]",
            'Example: /issue https://github.com/org/repo/issues/42',
            'Example: /issue PROJ-123',
            'Example: /issue 99 --tracker ado',
          ].join("\n"),
          "error",
        );
        return;
      }

      const resolution = await detectTracker(ticketRef, trackerFlag);

      if (resolution.tracker === "unknown") {
        ctx.ui.notify(
          [
            `Could not detect issue tracker for: ${ticketRef}`,
            "",
            "Specify the tracker using one of these methods:",
            "  1. Pass a full ticket URL (github.com, dev.azure.com, atlassian.net)",
            "  2. Use --tracker flag:  /issue <id> --tracker github|ado|jira",
            "  3. Jira IDs are auto-detected (e.g. PROJ-123)",
            '  4. Create ~/.pi/engteam/issue-tracker.json: { "default": "github" }',
            "  5. Ensure a git remote pointing to github.com or dev.azure.com",
          ].join("\n"),
          "error",
        );
        return;
      }

      for (const def of agentDefs) {
        await team.ensureTeammate(def.name, def);
      }

      const analyzeGoal = `${ticketRef} [tracker:${resolution.tracker}]`;
      const analyzeRun = await engine.startRun({
        workflow: "issue-analyze",
        goal: analyzeGoal,
        budget: {},
      });

      ctx.ui.notify(
        `▶ Fetching ${resolution.tracker} #${resolution.ticketId}…`,
        "info",
      );

      const finalState = await engine.executeRun(analyzeRun.runId);

      if (finalState.status !== "succeeded") {
        const analyzeStep = finalState.steps.find(s => s.name === "analyze");
        const reason = analyzeStep?.issues?.join(", ") ?? analyzeStep?.error ?? "unknown error";
        ctx.ui.notify(`Failed to analyze ticket: ${reason}`, "error");
        return;
      }

      const briefPath = join(runsDir, analyzeRun.runId, "issue-brief.md");
      let briefText: string;
      try {
        briefText = await readFile(briefPath, "utf8");
      } catch {
        ctx.ui.notify("Issue analyst did not write issue-brief.md.", "error");
        return;
      }

      const parsed = parseBrief(briefText);
      if (!parsed) {
        ctx.ui.notify(
          "Could not parse Suggested Workflow or Goal from issue-brief.md. Open the file and check its format.",
          "error",
        );
        return;
      }

      const { suggestedWorkflow, goal } = parsed;
      const goalWithContext = `${goal}\n\n[Issue context available at: ${briefPath}]`;

      ctx.ui.notify(
        `Issue brief ready → ${briefPath}\nChaining into: ${suggestedWorkflow}`,
        "info",
      );

      const downstream = await engine.startRun({
        workflow: suggestedWorkflow,
        goal: goalWithContext,
        budget: {},
        initialArtifacts: [briefPath],
      });

      if (suggestedWorkflow === "spec-plan-build-review") {
        await executeSpecWorkflow(engine, runsDir, downstream.runId, ctx);
      } else {
        void engine.executeRun(downstream.runId);
        ctx.ui.notify(
          [
            `▶ ${suggestedWorkflow} started (run ${downstream.runId.slice(0, 8)})`,
            `Goal: ${goal}`,
            ``,
            `Watch progress:`,
            `  /run-status ${downstream.runId}`,
            `  /observe  (dashboard at http://127.0.0.1:4747)`,
            `  tail -f ~/.pi/engteam/runs/${downstream.runId}/events.jsonl`,
          ].join("\n"),
          "info",
        );
      }
    },
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm test tests/unit/commands/issue.test.ts
```
Expected: all 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/issue.ts tests/unit/commands/issue.test.ts
git commit -m "feat: add /issue command with two-phase execute-and-chain workflow"
```

---

## Task 8: Wire everything in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `issue-analyst` to `AGENT_DEFS` and import + register the new workflow and command**

In `src/index.ts`, make these four changes:

**Change A** — add import for the new workflow and command (after the `specPlanBuildReview` import):

```typescript
import { issueAnalyze } from "./workflows/issue-analyze.js";
import { registerIssueCommand } from "./commands/issue.js";
```

**Change B** — add `issue-analyst` to `AGENT_DEFS` (after the `architect` entry):

```typescript
  {
    name: "issue-analyst",
    description: "Fetches issue tickets from GitHub, ADO, or Jira CLIs and extracts structured requirements",
    model: "claude-haiku-4-5-20251001",
    systemPrompt:
      "You are the Issue Analyst agent for the pi-engteam engineering team. " +
      "Read the goal to get the ticket reference and tracker type. " +
      "Fetch the ticket using the appropriate pre-authenticated CLI (gh, az, or jira). " +
      "Extract the requirements and write issue-brief.md with all required sections. " +
      "Select the appropriate downstream workflow based on issue type. " +
      "Always call VerdictEmit at the end of your turn with step='analyze'.",
  },
```

**Change C** — add `issueAnalyze` to the workflows Map:

```typescript
    ["issue-analyze", issueAnalyze],
```

Add this entry after the `["spec-plan-build-review", specPlanBuildReview]` line.

**Change D** — register the `/issue` command after `registerSpecCommand`:

```typescript
  registerIssueCommand(pi, engine, team, AGENT_DEFS, RUNS_DIR);
```

- [ ] **Step 2: Run the full test suite**

```bash
pnpm test
```
Expected: all tests PASS

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```
Expected: no errors

- [ ] **Step 4: Run build**

```bash
pnpm build
```
Expected: build succeeds, `dist/index.js` and `dist/server.cjs` written

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire issue-analyze workflow, issue-analyst agent, and /issue command into extension"
```
