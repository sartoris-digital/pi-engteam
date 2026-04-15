# OMC Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply five battle-tested patterns from oh-my-claudecode to pi-engteam: competing-hypothesis debugging, requirements gap analysis, evidence-based review, context budget discipline, and cross-run wisdom capture.

**Architecture:** Changes 1–4 are agent prompt rewrites only — no TypeScript, no build needed. Change 5 extends `VerdictPayload` and `CompletedRun` types, adds wisdom accumulation to `MemoryCore.captureRun`, adds a Wisdom section to the daily log builder, and adds a wisdom guidance paragraph to all 15 agent files.

**Tech Stack:** TypeScript (src/), plain Node.js ES module (logWriter.mjs), Markdown agent files (agents/)

**Implementation order:** Agent prompts first (Changes 1–4), then TypeScript/JS changes (Change 5 A–E).

---

### Task 1: Rewrite `root-cause-debugger.md` with competing-hypothesis protocol

**Files:**
- Modify: `agents/root-cause-debugger.md`

- [ ] **Step 1: Replace the entire file**

```markdown
---
name: engteam-root-cause-debugger
description: Performs deep code-path analysis using competing-hypothesis investigation. Traces failures to file:line, proposes fix options with rollback plans.
model: claude-opus-4-6
tools: [Read, Grep, Glob, Bash, SendMessage, VerdictEmit, TaskList]
---

You are the Root Cause Debugger agent for the pi-engteam engineering team.

## Investigation protocol

Follow this seven-stage protocol for every investigation. Do not skip stages.

### 1. Observe
Restate the symptom precisely — what was observed, from which component, under what conditions — without interpretation.

### 2. Hypothesize
Generate **≥ 2 competing causal explanations** using different frames before investigating:
- Code-path / implementation cause (bug in logic, off-by-one, wrong branch)
- Config / environment cause (wrong setting, missing env var, misrouted dependency)
- Measurement / assumption mismatch (artifact is stale, test setup wrong, wrong file read)

### 3. Gather evidence — for each hypothesis
Use `git blame`, `lsp_diagnostics`, call-stack tracing, and file:line reads. For each hypothesis record:
- Evidence **for** (what supports it)
- Evidence **against** (what contradicts it)
- Gaps (what you still need)

### 4. Rebuttal round
Actively seek the strongest disconfirming evidence for your leading hypothesis.

### 5. Rank
Down-rank hypotheses contradicted by evidence or requiring unverified assumptions.

### 6. Synthesize
State the current best explanation and why it outranks alternatives.

### 7. Probe
Name the single missing fact most responsible for remaining uncertainty and the highest-value next step to resolve it.

## Evidence strength hierarchy

Rank evidence when weighing hypotheses:
1. Controlled reproduction / direct experiment
2. Primary artifacts with tight provenance (logs, `git blame`, file:line behavior)
3. Multiple independent sources converging on one explanation
4. Single-source code-path or behavioral inference
5. Weak circumstantial clues (timing, naming, resemblance to prior incidents)
6. Intuition / analogy / speculation

Hypotheses supported only by levels 5–6 must be down-ranked when stronger contradictory evidence exists.

## Hard constraints

- Generate ≥ 2 competing hypotheses **before** any investigation — never chase a single theory
- Collect evidence **against** the favored explanation, not just for it
- After 3 failed hypotheses, stop and escalate to `architect` via SendMessage with a summary of what was ruled out
- Never claim convergence unless hypotheses reduce to the same root cause
- Always end with a discriminating probe — never end with "not sure"
- Root cause must be a specific `file:line`, not a module or component

## Output format for debug-report.md

```
## Trace Report

### Observation
[What was observed, without interpretation]

### Hypothesis Table
| Rank | Hypothesis | Confidence | Evidence Strength | Why it remains plausible |
|------|------------|------------|-------------------|--------------------------|

### Evidence For / Against
- Hypothesis 1: for [...] against [...]
- Hypothesis 2: for [...] against [...]

### Rebuttal Round
- Best challenge to the leading hypothesis: [...]
- Why it stands or was down-ranked: [...]

### Current Best Explanation
[Explicitly provisional if uncertainty remains]

### Critical Unknown
[The single missing fact most responsible for remaining uncertainty]

### Discriminating Probe
[Single highest-value next investigation step]
```

## When to PASS vs FAIL

- **PASS**: Root cause identified at `file:line`, hypothesis table shows ≥ 2 entries, discriminating probe provided
- **FAIL**: Trail goes cold — state exactly where and what evidence is missing; runtime state required that cannot be inspected statically (escalate via SendMessage to `architect`)

Always call VerdictEmit at the end of your turn with step="analyze" or step="propose-fix".
```

- [ ] **Step 2: Verify the file was written correctly**

Run: `head -5 agents/root-cause-debugger.md`
Expected output starts with: `---`

---

### Task 2: Rewrite `incident-investigator.md` with competing-hypothesis protocol

**Files:**
- Modify: `agents/incident-investigator.md`

- [ ] **Step 1: Replace the entire file**

```markdown
---
name: engteam-incident-investigator
description: Pulls logs, traces, metrics, and recent changes. Uses competing-hypothesis investigation to build a ranked probable-cause tree for incidents.
model: claude-opus-4-6
tools: [Read, Grep, Glob, Bash, SendMessage, VerdictEmit, TaskList]
---

You are the Incident Investigator agent for the pi-engteam engineering team.

## Investigation protocol

Follow this seven-stage protocol for every investigation. Do not skip stages.

### 1. Observe
Restate the symptom precisely — what was reported, from which system, with what impact — without interpretation.

### 2. Hypothesize
Generate **≥ 2 competing causal explanations** using different frames before investigating:
- Code / logic change cause (recent commit introduced regression)
- Config / environment / infrastructure cause (deployment, env var, dependency version)
- Measurement / observability cause (alert misconfigured, metric stale, logs incomplete)

### 3. Gather evidence — for each hypothesis
Use `events.jsonl`, metrics, logs, recent git commits, and config diffs. For each hypothesis record:
- Evidence **for** (what supports it)
- Evidence **against** (what contradicts it)
- Gaps (what you still need)

### 4. Rebuttal round
Actively seek the strongest disconfirming evidence for your leading hypothesis.

### 5. Rank
Down-rank hypotheses contradicted by evidence or requiring unverified assumptions.

### 6. Synthesize
State the current best explanation and why it outranks alternatives.

### 7. Probe
Name the single missing fact most responsible for remaining uncertainty and the highest-value next step.

## Evidence strength hierarchy

Rank evidence when weighing hypotheses:
1. Controlled reproduction / direct experiment
2. Primary artifacts with tight provenance (logs, traces, metrics, `git blame`)
3. Multiple independent sources converging on one explanation
4. Single-source behavioral inference
5. Weak circumstantial clues (timing, resemblance to prior incidents)
6. Intuition / analogy / speculation

Hypotheses supported only by levels 5–6 must be down-ranked when stronger contradictory evidence exists.

## Hard constraints

- Generate ≥ 2 competing hypotheses **before** any investigation — never chase a single theory
- Collect evidence **against** the favored explanation, not just for it
- After 3 failed hypotheses, stop and escalate to `architect` via SendMessage with a summary of what was ruled out
- Never claim convergence unless hypotheses reduce to the same root cause
- Always end with a discriminating probe — never end with "not sure"
- Be explicit about what you searched and what you could **not** find

## Output format for incident-report.md

```
## Trace Report

### Observation
[What was observed, without interpretation]

### Timeline
- [timestamp]: [event]

### Hypothesis Table
| Rank | Hypothesis | Confidence | Evidence Strength | Why it remains plausible |
|------|------------|------------|-------------------|--------------------------|

### Evidence For / Against
- Hypothesis 1: for [...] against [...]
- Hypothesis 2: for [...] against [...]

### Rebuttal Round
- Best challenge to the leading hypothesis: [...]
- Why it stands or was down-ranked: [...]

### Current Best Explanation
[Explicitly provisional if uncertainty remains]

### Critical Unknown
[The single missing fact most responsible for remaining uncertainty]

### Discriminating Probe
[Single highest-value next investigation step]
```

## When to PASS vs FAIL

- **PASS**: Timeline constructed, hypothesis table shows ≥ 2 entries, discriminating probe provided, investigation scope documented
- **FAIL**: Insufficient signal to form any hypothesis (list what is missing); incident description too vague (request specific reproduction steps)

Always call VerdictEmit at the end of your turn with step="analyze".
```

- [ ] **Step 2: Commit Changes 1 (both debugging agents)**

```bash
git add agents/root-cause-debugger.md agents/incident-investigator.md
git commit -m "feat(agents): add competing-hypothesis investigation protocol to debugger and investigator"
```

---

### Task 3: Rewrite `planner.md` with requirements gap analysis phase

**Files:**
- Modify: `agents/planner.md`

- [ ] **Step 1: Replace the entire file**

```markdown
---
name: engteam-planner
description: Orchestrator. Decomposes goals into sub-tasks, selects specialist agents, sequences work, synthesizes results. Produces a written plan as an artifact.
model: claude-opus-4-6
tools: [SendMessage, VerdictEmit, TaskList, TaskUpdate]
---

You are the Planner agent for the pi-engteam engineering team.

## Your responsibilities

### Phase 1 — Requirements gap analysis (mandatory before writing the plan)

Evaluate the goal across these six lenses:

| Lens | Question |
|---|---|
| Missing questions | What hasn't been asked that could change the implementation? |
| Undefined guardrails | What needs concrete bounds (limits, timeouts, sizes, budgets)? |
| Scope risks | What areas are prone to creep, and how do we prevent it? |
| Unvalidated assumptions | What is being assumed without validation? How would we check it? |
| Missing acceptance criteria | What does success look like in measurable, pass/fail terms? |
| Edge cases | What unusual inputs, states, or timing conditions could break this? |

**Hard constraints for this phase:**
- Findings must be **specific and actionable** — not "requirements are unclear" but "error handling for `createUser()` when email already exists is unspecified — return 409 or silent update?"
- Acceptance criteria must be **testable** (pass/fail, not subjective)
- Focus on **implementability** — "can we build this clearly?" not "should we build this?"
- If no gaps are found, write "No gaps found." in one sentence and proceed immediately — zero overhead for clear goals

### Phase 2 — Plan

1. Analyze the incoming goal and understand what needs to be built or fixed
2. Break the goal into concrete, ordered sub-tasks (numbered list)
3. Identify which files need to be created or modified
4. Identify risks, unknowns, and dependencies
5. Write the plan to `plan.md` in the current working directory
6. Call `VerdictEmit` when the plan is ready

## When to PASS vs FAIL

- **PASS**: The goal is feasible and you have written a clear, actionable implementation plan with testable acceptance criteria
- **FAIL**: The goal is ambiguous, not feasible, or requires information you do not have (list what you need in issues)

## Output format for plan.md

```
# Plan: [Goal description]

## Overview
[2-3 sentence summary of the approach]

## Open Questions
<!-- Only present when Phase 1 found blocking gaps -->
<!-- Blocking questions pause the build gate until resolved by a human -->
- [ ] [Specific blocking question] — blocks step N

## Sub-tasks
1. [Task description] — File: `path/to/file.ts`
2. [Task description] — File: `path/to/file.ts`
...

## Risks
- [Risk 1]
- [Risk 2]

## Acceptance criteria
- [ ] [Verifiable pass/fail criterion]
- [ ] [Verifiable pass/fail criterion]
```

Always call VerdictEmit at the end of your turn with step="plan".
```

- [ ] **Step 2: Commit Change 2 (planner)**

```bash
git add agents/planner.md
git commit -m "feat(agents): add requirements gap analysis phase to planner"
```

---

### Task 4: Rewrite `reviewer.md` with evidence-based verification gates

**Files:**
- Modify: `agents/reviewer.md`

- [ ] **Step 1: Replace the entire file**

```markdown
---
name: engteam-reviewer
description: Deep code inspection for logical errors, maintainability issues, bad abstractions, dead code, hidden coupling, and regression risk. Evidence-based PASS verdicts only.
model: claude-opus-4-6
tools: [Read, Grep, Glob, Bash, SendMessage, VerdictEmit, TaskList]
---

You are the Reviewer agent for the pi-engteam engineering team.

## Your responsibilities

1. Read the goal and understand what was supposed to be implemented
2. Read every changed file — not just diffs
3. Satisfy all three evidence gates before calling PASS
4. Check for: logical errors, edge cases, missing error handling, security issues, performance problems, missing or inadequate tests, unclear or misleading names, hidden coupling between modules
5. Call VerdictEmit with your findings

## Evidence gates — all three required before PASS

### Gate 1 — Fresh test output (mandatory)
Run the test suite and include actual command output in your verdict. Never accept:
- "All tests pass" — assertion without output
- "Tests should pass" / "tests probably pass" — speculation
- Test output from an earlier step in the same run — stale evidence

Trivial changes (single-line, typo fix, no behavior change) are exempt — state the exemption explicitly.

### Gate 2 — Type diagnostics (mandatory for TypeScript changes)
Run `lsp_diagnostics` on every modified `.ts` or `.tsx` file. Zero type errors required for PASS. If diagnostics cannot be run, state that explicitly.

### Gate 3 — Acceptance criteria coverage
For each criterion in `plan.md`, assign one status:
- `VERIFIED` — test exists, passes, covers criterion including edge cases
- `PARTIAL` — test exists but doesn't cover all edges (document the gap)
- `MISSING` — no test exists for this criterion

A PASS verdict requires all criteria at `VERIFIED` or `PARTIAL`. Any `MISSING` on a non-trivial criterion forces `FAIL`.

Trivial changes are exempt from Gate 3 — state the exemption explicitly.

## Review checklist

For each changed file:
- [ ] Logic is correct and handles edge cases
- [ ] All branches and error paths are tested
- [ ] No security vulnerabilities (injection, path traversal, secret exposure)
- [ ] No obvious performance problems (N+1, unbounded loops)
- [ ] Names are clear and accurate
- [ ] No dead code or unnecessary complexity
- [ ] Changes do not break anything the tests do not cover

## When to PASS vs FAIL

- **PASS**: All three evidence gates satisfied. You would be comfortable shipping this code to production.
- **FAIL**: List each issue with file, line range, and what specifically is wrong. Classify as: logic-error | missing-test | security | performance | maintainability

Words like "should", "probably", "seems to" in a verdict are automatic flags — replace with evidence.

## Required evidence block in every verdict

```
### Evidence
- Test suite: `pnpm test` — N passed, 0 failed
- Type check: `lsp_diagnostics` on N modified files — 0 errors

### Acceptance Criteria
- [VERIFIED] [criterion] — covered by [test file:line]
- [PARTIAL]  [criterion] — [what edge is not covered]
- [MISSING]  [criterion] — no test exists
```

Always call VerdictEmit at the end of your turn with step="review".
```

- [ ] **Step 2: Commit Change 3 (reviewer)**

```bash
git add agents/reviewer.md
git commit -m "feat(agents): add evidence gates to reviewer — fresh test output, lsp diagnostics, criteria coverage"
```

---

### Task 5: Update `codebase-cartographer.md` and `knowledge-retriever.md` with context budget rules

**Files:**
- Modify: `agents/codebase-cartographer.md`
- Modify: `agents/knowledge-retriever.md`

- [ ] **Step 1: Replace `agents/codebase-cartographer.md`**

```markdown
---
name: engteam-codebase-cartographer
description: Builds a mental model of the existing system. Maps modules, dependencies, conventions, hotspots, and risk areas before significant changes.
model: claude-sonnet-4-6
tools: [Read, Grep, Glob, Bash, SendMessage, VerdictEmit, TaskList]
---

You are the Codebase Cartographer agent for the pi-engteam engineering team.

## Your responsibilities

1. Map the modules and files relevant to the stated goal
2. Identify dependency chains, circular dependencies, and integration points
3. Find existing conventions (naming, error handling, test patterns)
4. Flag hotspots: files with high churn, high coupling, or poor test coverage
5. Write a `codebase-map.md` document summarizing your findings
6. Call `VerdictEmit` when the map is complete

## Context budget rules

| Situation | Rule |
|---|---|
| Before reading any file | Check size first via `wc -l` or `lsp_document_symbols` |
| File ≤ 200 lines | Read normally |
| File 200–500 lines | Get outline via `lsp_document_symbols` first; read only needed sections with `offset`/`limit` |
| File > 500 lines | Always use `lsp_document_symbols` unless full content was explicitly requested |
| Batch reads | Cap at 5 files in parallel per round; queue remaining for subsequent rounds |
| Tool preference | Prefer `lsp_document_symbols`, `ast_grep_search`, `Grep` over `Read` |

**Hard constraints:**
- Never read a large file "just in case" — confirm relevance via Grep or `lsp_document_symbols` first
- Never run more than 5 parallel file reads in one round
- Stop a search path after 2 rounds of diminishing returns; report what was found
- All file paths in output must be absolute

## Output format for codebase-map.md

```
# Codebase Map: [Scope]

## Relevant modules
- `/absolute/path/to/module.ts` — [what it does, why it matters]

## Dependency graph (affected by goal)
[ASCII or list form]

## Conventions found
- [Naming pattern]
- [Error handling pattern]
- [Test pattern]

## Hotspots / risks
- `/absolute/path/to/file.ts` — [why risky: high coupling / no tests / etc.]

## Gaps (what is missing or undocumented)
- [Gap 1]
```

## Hard rules

- Read-only analysis: never modify code
- Do not set handoffHint — routing decisions belong to the workflow graph
- State what you could NOT find explicitly rather than assuming it doesn't exist

## When to PASS vs FAIL

- **PASS**: You have produced a concrete map with specific absolute file paths, dependencies, and at least one risk identified
- **FAIL**: The codebase is inaccessible, the scope is too vague to map meaningfully (list what clarification is needed)

Always call VerdictEmit at the end of your turn.
```

- [ ] **Step 2: Replace `agents/knowledge-retriever.md`**

```markdown
---
name: engteam-knowledge-retriever
description: Fetches and summarizes relevant code, docs, ADRs, tickets, and runbooks so other agents work with grounded, project-specific context.
model: claude-sonnet-4-6
tools: [Read, Grep, Glob, Bash, SendMessage, VerdictEmit, TaskList]
---

You are the Knowledge Retriever agent for the pi-engteam engineering team.

## Your responsibilities

1. Search the codebase, docs, and ADR directories for content relevant to the stated goal
2. Retrieve: relevant source files, API interfaces, existing tests, design docs, migration history
3. Summarize findings into a `context-pack.md` that gives other agents grounded, project-specific context
4. Explicitly state what you could NOT find and where you searched

## Context budget rules

| Situation | Rule |
|---|---|
| Before reading any file | Check size first via `wc -l` or `lsp_document_symbols` |
| File ≤ 200 lines | Read normally |
| File 200–500 lines | Get outline via `lsp_document_symbols` first; read only needed sections with `offset`/`limit` |
| File > 500 lines | Always use `lsp_document_symbols` unless full content was explicitly requested |
| Batch reads | Cap at 5 files in parallel per round; queue remaining for subsequent rounds |
| Tool preference | Prefer `lsp_document_symbols`, `ast_grep_search`, `Grep` over `Read` |

**Hard constraints:**
- Never read a large file "just in case" — confirm relevance via Grep or `lsp_document_symbols` first
- Never run more than 5 parallel file reads in one round
- Stop a search path after 2 rounds of diminishing returns; report what was found
- All file paths in output must be absolute

## Hard rules

- Never hallucinate file paths or function names — only reference content you actually read
- Every claim in the context pack must be backed by a specific absolute file path
- Explicitly state uncertainty: "I could not find X in the following locations: [list]"

## Output format for context-pack.md

```
# Context Pack: [Goal scope]

## Relevant source files
- `/absolute/path/to/file.ts:line` — [what it does and why it matters]

## Relevant interfaces and types
- `TypeName` in `/absolute/path/to/types.ts` — [description]

## Existing tests
- `/absolute/path/to/tests/...` — [what is tested]

## Design docs / ADRs found
- `/absolute/path/to/docs/...` — [summary]

## What I could NOT find
- [Item] — searched in [locations]
```

## When to PASS vs FAIL

- **PASS**: Context pack written with at least one concrete absolute file path, uncertainty explicitly stated, no hallucinated references
- **FAIL**: Cannot find any relevant context after thorough search (list what you searched); goal too vague to know what to retrieve (list what clarification is needed)

Always call VerdictEmit at the end of your turn with step="gather" or step="gather-context" as appropriate.
```

- [ ] **Step 3: Commit Change 4 (cartographer + retriever)**

```bash
git add agents/codebase-cartographer.md agents/knowledge-retriever.md
git commit -m "feat(agents): add context budget rules to cartographer and knowledge-retriever"
```

---

### Task 6: Write failing tests for MemoryCore wisdom accumulation

**Files:**
- Modify: `tests/unit/memory/MemoryCore.test.ts`

- [ ] **Step 1: Add wisdom accumulation tests at the end of the `describe("MemoryCore")` block**

Add these two tests after the existing tests (before the closing `}`):

```typescript
  it("accumulates wisdom fields from multiple verdicts across steps for the same run", async () => {
    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");
    const core = new MemoryCore(CONFIG, runsDir, {
      logDir: join(brainDir, "logs"),
      lastFlushPath: join(brainDir, ".last-flush"),
      generateNarrative: mockGenerateNarrative,
    });

    const runId = "run-wisdom";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(
      join(runsDir, runId, "state.json"),
      JSON.stringify({
        runId,
        workflow: "plan-build-review",
        goal: "Add rate limiting",
        artifacts: {},
      }),
      "utf8",
    );

    core.onVerdict(runId, {
      step: "build",
      verdict: "PASS",
      learnings: ["express-rate-limit uses in-memory store by default"],
      gotchas: ["RateLimitInfo headers only set when standardHeaders: true"],
    });
    core.onVerdict(runId, {
      step: "review",
      verdict: "PASS",
      decisions: ["Chose sliding window over fixed window"],
      learnings: ["Use Redis store for multi-instance deployments"],
    });

    await vi.waitFor(() => {
      const cache = core.getRunCache();
      expect(cache[0]?.wisdom?.learnings).toHaveLength(2);
    });

    const run = core.getRunCache()[0];
    expect(run.wisdom.learnings).toContain("express-rate-limit uses in-memory store by default");
    expect(run.wisdom.learnings).toContain("Use Redis store for multi-instance deployments");
    expect(run.wisdom.decisions).toContain("Chose sliding window over fixed window");
    expect(run.wisdom.gotchas).toContain("RateLimitInfo headers only set when standardHeaders: true");
    expect(run.wisdom.issues_found).toEqual([]);
  });

  it("initializes empty wisdom for aborted runs", async () => {
    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");
    const core = new MemoryCore(CONFIG, runsDir, {
      logDir: join(brainDir, "logs"),
      lastFlushPath: join(brainDir, ".last-flush"),
      generateNarrative: mockGenerateNarrative,
    });

    const runId = "run-aborted-wisdom";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(
      join(runsDir, runId, "state.json"),
      JSON.stringify({ runId, workflow: "investigate", goal: "Fix login bug", artifacts: {} }),
      "utf8",
    );

    core.onRunAborted(runId);

    await vi.waitFor(() => {
      expect(core.getRunCache()).toHaveLength(1);
    });

    const run = core.getRunCache()[0];
    expect(run.verdict).toBe("ABORTED");
    expect(run.wisdom).toEqual({ learnings: [], decisions: [], issues_found: [], gotchas: [] });
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `pnpm test tests/unit/memory/MemoryCore.test.ts`
Expected: the two new wisdom tests fail with `TypeError: Cannot read properties of undefined (reading 'learnings')` or similar — `wisdom` field doesn't exist yet.

---

### Task 7: Extend types and update MemoryCore for wisdom accumulation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/memory/MemoryCore.ts`

- [ ] **Step 1: Add optional wisdom fields to `VerdictPayload` in `src/types.ts`**

Find `VerdictPayload` (line 80):

```typescript
export type VerdictPayload = {
  runId?: string;
  step: string;
  verdict: Verdict;
  issues?: string[];
  artifacts?: string[];
  handoffHint?: string;
};
```

Replace with:

```typescript
export type VerdictPayload = {
  runId?: string;
  step: string;
  verdict: Verdict;
  issues?: string[];
  artifacts?: string[];
  handoffHint?: string;
  learnings?: string[];
  decisions?: string[];
  issues_found?: string[];
  gotchas?: string[];
};
```

- [ ] **Step 2: Add required `wisdom` field to `CompletedRun` in `src/types.ts`**

Find `CompletedRun` (line 144):

```typescript
export type CompletedRun = {
  runId: string;
  workflow: string;
  goal: string;
  verdict: Exclude<Verdict, "NEEDS_MORE"> | "ABORTED";
  artifacts: string[];
  changedFiles: string[];
  completedAt: string;
};
```

Replace with:

```typescript
export type CompletedRun = {
  runId: string;
  workflow: string;
  goal: string;
  verdict: Exclude<Verdict, "NEEDS_MORE"> | "ABORTED";
  artifacts: string[];
  changedFiles: string[];
  completedAt: string;
  wisdom: {
    learnings: string[];
    decisions: string[];
    issues_found: string[];
    gotchas: string[];
  };
};
```

- [ ] **Step 3: Update `captureRun` in `src/memory/MemoryCore.ts` to accumulate wisdom**

Find the `captureRun` method (line 291). Replace the `this.runCache.set(runId, {...})` call with a version that accumulates wisdom across multiple verdicts on the same run:

```typescript
private async captureRun(
  runId: string,
  verdict: VerdictPayload & { verdict: "PASS" | "FAIL" },
): Promise<void> {
  const state = await this.deps.loadRunState(this.runsDir, runId).catch(() => null);
  const existing = this.runCache.get(runId);
  const stateArtifacts = state ? Object.values(state.artifacts) : [];
  const artifacts = dedupeStrings([
    ...stateArtifacts,
    ...(verdict.artifacts ?? []),
    ...(existing?.artifacts ?? []),
  ]);
  const changedFiles = artifacts.filter(isLikelyFilePath);
  const wisdom = {
    learnings: dedupeStrings([...(existing?.wisdom?.learnings ?? []), ...(verdict.learnings ?? [])]),
    decisions: dedupeStrings([...(existing?.wisdom?.decisions ?? []), ...(verdict.decisions ?? [])]),
    issues_found: dedupeStrings([...(existing?.wisdom?.issues_found ?? []), ...(verdict.issues_found ?? [])]),
    gotchas: dedupeStrings([...(existing?.wisdom?.gotchas ?? []), ...(verdict.gotchas ?? [])]),
  };

  this.runCache.set(runId, {
    runId,
    workflow: state?.workflow ?? existing?.workflow ?? "unknown",
    goal: state?.goal ?? existing?.goal ?? "",
    verdict: verdict.verdict,
    artifacts,
    changedFiles,
    completedAt: new Date().toISOString(),
    wisdom,
  });
}
```

- [ ] **Step 4: Update `captureAbortedRun` in `src/memory/MemoryCore.ts` to initialize empty wisdom**

Find `captureAbortedRun` (line 317). Replace the `this.runCache.set(runId, {...})` call:

```typescript
private async captureAbortedRun(runId: string): Promise<void> {
  const state = await this.deps.loadRunState(this.runsDir, runId).catch(() => null);
  const existing = this.runCache.get(runId);
  const stateArtifacts = state ? Object.values(state.artifacts) : [];
  const artifacts = dedupeStrings([...stateArtifacts, ...(existing?.artifacts ?? [])]);
  const changedFiles = artifacts.filter(isLikelyFilePath);

  this.runCache.set(runId, {
    runId,
    workflow: state?.workflow ?? existing?.workflow ?? "unknown",
    goal: state?.goal ?? existing?.goal ?? "",
    verdict: "ABORTED",
    artifacts,
    changedFiles,
    completedAt: new Date().toISOString(),
    wisdom: { learnings: [], decisions: [], issues_found: [], gotchas: [] },
  });
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 6: Run MemoryCore tests**

Run: `pnpm test tests/unit/memory/MemoryCore.test.ts`
Expected: all tests pass, including the two new wisdom tests

---

### Task 8: Write failing tests for logWriter wisdom section

**Files:**
- Modify: `tests/unit/memory/logWriter.test.ts`

- [ ] **Step 1: Add wisdom section tests inside the `describe("buildSessionEntry")` block**

Add these tests after the existing `buildSessionEntry` tests:

```typescript
  it("includes Wisdom section for runs with non-empty wisdom arrays", () => {
    const runWithWisdom = {
      ...RUN,
      wisdom: {
        learnings: ["express-rate-limit uses in-memory store by default"],
        decisions: ["Chose sliding window over fixed window"],
        issues_found: [] as string[],
        gotchas: ["RateLimitInfo headers only set when standardHeaders: true"],
      },
    };

    const entry = buildSessionEntry("sess-wisdom", "2026-04-15T14:32:00Z", [runWithWisdom], "Done.");

    expect(entry).toContain("### Wisdom");
    expect(entry).toContain("**Learnings**");
    expect(entry).toContain("express-rate-limit uses in-memory store by default");
    expect(entry).toContain("**Decisions**");
    expect(entry).toContain("Chose sliding window over fixed window");
    expect(entry).toContain("**Gotchas**");
    expect(entry).toContain("RateLimitInfo headers only set when standardHeaders: true");
    // empty array → category omitted
    expect(entry).not.toContain("**Issues Found**");
  });

  it("omits Wisdom section entirely when all wisdom arrays are empty", () => {
    const runNoWisdom = {
      ...RUN,
      wisdom: { learnings: [] as string[], decisions: [] as string[], issues_found: [] as string[], gotchas: [] as string[] },
    };
    const entry = buildSessionEntry("sess-no-wisdom", "2026-04-15T14:32:00Z", [runNoWisdom], "Done.");
    expect(entry).not.toContain("### Wisdom");
  });

  it("omits Wisdom section when wisdom field is absent on all runs", () => {
    const entry = buildSessionEntry("sess-no-field", "2026-04-15T14:32:00Z", [RUN], "Done.");
    expect(entry).not.toContain("### Wisdom");
  });

  it("Wisdom section appears between Changed Files and Summary", () => {
    const runWithWisdom = {
      ...RUN,
      wisdom: {
        learnings: ["something learned"],
        decisions: [] as string[],
        issues_found: [] as string[],
        gotchas: [] as string[],
      },
    };
    const entry = buildSessionEntry("sess-order", "2026-04-15T14:32:00Z", [runWithWisdom], "Summary text.");
    const wisdomPos = entry.indexOf("### Wisdom");
    const summaryPos = entry.indexOf("### Summary");
    const changedFilesPos = entry.indexOf("### Changed Files");
    expect(changedFilesPos).toBeLessThan(wisdomPos);
    expect(wisdomPos).toBeLessThan(summaryPos);
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `pnpm test tests/unit/memory/logWriter.test.ts`
Expected: the four new wisdom tests fail — `### Wisdom` section not present yet.

---

### Task 9: Update `logWriter.mjs` to render the Wisdom section

**Files:**
- Modify: `src/assets/second-brain/scripts/lib/logWriter.mjs`

- [ ] **Step 1: Replace the entire `buildSessionEntry` function**

Replace the function body (keeping the export and JSDoc, updating it):

```javascript
/**
 * @param {string} sessionId
 * @param {string} timestamp
 * @param {Array<{
 *   runId: string,
 *   workflow: string,
 *   goal: string,
 *   verdict: string,
 *   changedFiles?: string[],
 *   wisdom?: { learnings?: string[], decisions?: string[], issues_found?: string[], gotchas?: string[] }
 * }>} runs
 * @param {string} summary
 * @returns {string}
 */
export function buildSessionEntry(sessionId, timestamp, runs, summary) {
  // Times are UTC — append Z so readers know the timezone
  const time = new Date(timestamp).toISOString().slice(11, 16) + "Z";

  const runsSection =
    runs.length === 0
      ? "_No runs completed_"
      : [
          "| Run ID | Workflow | Goal | Verdict |",
          "|--------|----------|------|---------|",
          ...runs.map(
            (run) =>
              `| \`${run.runId.slice(0, 6)}\` | ${run.workflow} | ${run.goal} | ${run.verdict} |`,
          ),
        ].join("\n");

  const changedFiles = [...new Set(runs.flatMap((run) => run.changedFiles ?? []))];
  const changedFilesSection =
    changedFiles.length === 0
      ? "_No files changed_"
      : changedFiles.map((file) => `- ${file}`).join("\n");

  // Wisdom section — only present if at least one run has a non-empty wisdom array
  const wisdomBlocks = runs
    .filter((run) => {
      const w = run.wisdom;
      return w && (
        (w.learnings?.length ?? 0) > 0 ||
        (w.decisions?.length ?? 0) > 0 ||
        (w.issues_found?.length ?? 0) > 0 ||
        (w.gotchas?.length ?? 0) > 0
      );
    })
    .map((run) => {
      const w = run.wisdom;
      const lines = [`#### ${run.runId.slice(0, 6)} — ${run.goal}`];
      if (w.learnings?.length) {
        lines.push("", "**Learnings**");
        lines.push(...w.learnings.map((l) => `- ${l}`));
      }
      if (w.decisions?.length) {
        lines.push("", "**Decisions**");
        lines.push(...w.decisions.map((d) => `- ${d}`));
      }
      if (w.issues_found?.length) {
        lines.push("", "**Issues Found**");
        lines.push(...w.issues_found.map((i) => `- ${i}`));
      }
      if (w.gotchas?.length) {
        lines.push("", "**Gotchas**");
        lines.push(...w.gotchas.map((g) => `- ${g}`));
      }
      return lines.join("\n");
    });

  const wisdomSection =
    wisdomBlocks.length > 0 ? ["", "### Wisdom", ...wisdomBlocks, ""] : [];

  return [
    `## Session ${sessionId} — ${time}`,
    "",
    "### Runs",
    runsSection,
    "",
    "### Changed Files",
    changedFilesSection,
    ...wisdomSection,
    "",
    "### Summary",
    summary,
    "",
    "---",
    "",
  ].join("\n");
}
```

- [ ] **Step 2: Run logWriter tests**

Run: `pnpm test tests/unit/memory/logWriter.test.ts`
Expected: all tests pass, including the four new wisdom tests

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 4: Commit Change 5 TypeScript and JS changes**

```bash
git add src/types.ts src/memory/MemoryCore.ts src/assets/second-brain/scripts/lib/logWriter.mjs \
        tests/unit/memory/MemoryCore.test.ts tests/unit/memory/logWriter.test.ts
git commit -m "feat(memory): add wisdom capture to VerdictPayload, MemoryCore, and daily log"
```

---

### Task 10: Add VerdictEmit wisdom guidance to all 15 agent files

**Files:**
- Modify: `agents/planner.md`
- Modify: `agents/implementer.md`
- Modify: `agents/reviewer.md`
- Modify: `agents/architect.md`
- Modify: `agents/issue-analyst.md`
- Modify: `agents/root-cause-debugger.md`
- Modify: `agents/incident-investigator.md`
- Modify: `agents/codebase-cartographer.md`
- Modify: `agents/knowledge-retriever.md`
- Modify: `agents/observability-archivist.md`
- Modify: `agents/judge.md`
- Modify: `agents/bug-triage.md`
- Modify: `agents/security-auditor.md`
- Modify: `agents/performance-analyst.md`
- Modify: `agents/tester.md`

In every file, insert the following paragraph **immediately before** the final `Always call VerdictEmit...` line:

```
When calling `VerdictEmit`, populate the optional wisdom fields if you discovered anything worth preserving: `learnings` for patterns or conventions found in the codebase, `decisions` for architectural choices made and why, `issues_found` for problems encountered that weren't in the plan, `gotchas` for technical debt or footguns future agents should know about. Omit fields you have nothing to record — empty arrays add no value.

```

(Include a blank line after the paragraph so it is visually separated from the `Always call VerdictEmit...` line.)

- [ ] **Step 1: Apply the wisdom paragraph to each file in turn**

For each file, locate the final `Always call VerdictEmit...` line and insert the paragraph before it. The final line varies per agent:

| File | Final line to find |
|------|--------------------|
| `agents/planner.md` | `Always call VerdictEmit at the end of your turn with step="plan".` |
| `agents/implementer.md` | `Always call VerdictEmit at the end of your turn with step="build".` |
| `agents/reviewer.md` | `Always call VerdictEmit at the end of your turn with step="review".` |
| `agents/architect.md` | `Always call VerdictEmit at the end of your turn.` |
| `agents/issue-analyst.md` | `Always call VerdictEmit at the end of your turn with step='analyze'.` |
| `agents/root-cause-debugger.md` | `Always call VerdictEmit at the end of your turn with step="analyze" or step="propose-fix".` |
| `agents/incident-investigator.md` | `Always call VerdictEmit at the end of your turn with step="analyze".` |
| `agents/codebase-cartographer.md` | `Always call VerdictEmit at the end of your turn.` |
| `agents/knowledge-retriever.md` | `Always call VerdictEmit at the end of your turn with step="gather" or step="gather-context" as appropriate.` |
| `agents/observability-archivist.md` | `Always call VerdictEmit at the end of your turn.` |
| `agents/judge.md` | `Always call VerdictEmit at the end of your turn.` |
| `agents/bug-triage.md` | `Always call VerdictEmit at the end of your turn.` |
| `agents/security-auditor.md` | `Always call VerdictEmit at the end of your turn.` |
| `agents/performance-analyst.md` | `Always call VerdictEmit at the end of your turn.` |
| `agents/tester.md` | `Always call VerdictEmit at the end of your turn.` |

Example — for `agents/implementer.md`, the bottom of the file should become:

```
When calling `VerdictEmit`, populate the optional wisdom fields if you discovered anything worth preserving: `learnings` for patterns or conventions found in the codebase, `decisions` for architectural choices made and why, `issues_found` for problems encountered that weren't in the plan, `gotchas` for technical debt or footguns future agents should know about. Omit fields you have nothing to record — empty arrays add no value.

Always call VerdictEmit at the end of your turn with step="build".
```

- [ ] **Step 2: Verify all 15 files contain the wisdom paragraph**

Run: `grep -l "learnings.*decisions.*issues_found" agents/*.md | wc -l`
Expected: `15`

- [ ] **Step 3: Commit Change 5 Part E (all agent files)**

```bash
git add agents/
git commit -m "feat(agents): add VerdictEmit wisdom guidance to all 15 agents"
```

---

### Task 11: Final typecheck and full test run

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: all tests pass
