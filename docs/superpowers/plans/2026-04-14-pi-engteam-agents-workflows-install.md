# pi-engteam — Agents, Workflows, and Install Implementation Plan

**Date:** 2026-04-14
**Phase:** Plan B — 11 remaining agents, 9 workflows, install scripts, integration tests
**Sections:**
- Section 1: File structure, 11 agent .md files, plan-build-review-fix workflow
- Section 2: investigate, triage, verify, debug, fix-loop workflows
- Section 3: migration, refactor-campaign, doc-backfill workflows, install scripts, integration tests

---

# pi-engteam Agents, Workflows & Install — Implementation Plan B

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Add the remaining 11 specialist agents, 9 additional workflow graphs, install scripts, integration tests, and workflow shortcut slash commands to complete the full pi-engteam system.

**Prerequisites:** Plan A fully implemented and all tests passing.

**Tech Stack:** TypeScript 5, `@mariozechner/pi-coding-agent` v0.65+, `@sinclair/typebox`, vitest, tsup, shell scripts.

---

## File Structure

| Path | Purpose |
|---|---|
| `agents/architect.md` | Architect agent definition |
| `agents/codebase-cartographer.md` | Cartographer agent definition |
| `agents/tester.md` | Tester agent definition |
| `agents/security-auditor.md` | Security auditor agent definition |
| `agents/performance-analyst.md` | Performance analyst agent definition |
| `agents/bug-triage.md` | Bug triage agent definition |
| `agents/incident-investigator.md` | Incident investigator agent definition |
| `agents/root-cause-debugger.md` | Root-cause debugger agent definition |
| `agents/judge.md` | Judge (verdict authority) agent definition |
| `agents/knowledge-retriever.md` | Knowledge retriever agent definition |
| `agents/observability-archivist.md` | Observability archivist agent definition |
| `src/workflows/plan-build-review-fix.ts` | Plan → Build → Review → Fix loop |
| `src/workflows/investigate.ts` | Cartographer + retriever investigation graph |
| `src/workflows/triage.ts` | Bug-triage and routing |
| `src/workflows/verify.ts` | Tester + judge verification graph |
| `src/workflows/debug.ts` | Incident-investigator + root-cause-debugger |
| `src/workflows/fix-loop.ts` | Bounded implement → review → fix cycle |
| `src/workflows/migration.ts` | Architect + cartographer + implementer migration |
| `src/workflows/refactor-campaign.ts` | Multi-pass refactor with judge sign-off |
| `src/workflows/doc-backfill.ts` | Docs writer + reviewer backfill |
| `src/commands/plan-build-review-fix.ts` | Slash command handler |
| `src/commands/investigate.ts` | Slash command handler |
| `src/commands/triage.ts` | Slash command handler |
| `src/commands/verify.ts` | Slash command handler |
| `src/commands/debug.ts` | Slash command handler |
| `src/commands/fix-loop.ts` | Slash command handler |
| `src/commands/migration.ts` | Slash command handler |
| `src/commands/refactor-campaign.ts` | Slash command handler |
| `src/commands/doc-backfill.ts` | Slash command handler |
| `src/commands/engteam-install.ts` | Stage-2 install command |
| `src/commands/engteam-doctor.ts` | Health check command |
| `src/commands/engteam-uninstall.ts` | Uninstall command |
| `install.sh` | Stage-1 shell bootstrap |
| `scripts/install-stage2.ts` | Stage-2 TypeScript installer |
| `scripts/uninstall.ts` | Uninstall script |
| `prompts/team-comms.md` | Shared prompt fragment (MessageBus protocol) |
| `prompts/safe-autonomy.md` | Shared prompt fragment (RequestApproval/VerdictEmit etiquette) |
| `skills/engteam-conventions.md` | Skill file (repo conventions) |
| `skills/safe-autonomy.md` | Skill file (safety rules) |
| `skills/team-comms.md` | Skill file (team communication protocol) |
| `tests/integration/` | Integration test fixtures and specs |

---

## Phase 0 — Agent Definitions (Tasks 1-11)

Each agent file lives in `agents/<name>.md`. Frontmatter declares `name`, `description`, `model`, and `tools`. The system prompt is written as a working role briefing the agent reads at boot. Every agent's tool list explicitly includes the team comms tools (`TeamSend`, `TeamBroadcast`, `VerdictEmit`) and omits tools it does not need.

### Task 1: `architect` agent definition

**File:** `agents/architect.md`

- [ ] **Create `agents/architect.md`**

````markdown
---
name: architect
description: System designer. Produces ADR-style designs, service boundaries, and phased rollout plans. Consulted before large refactors, new services, or cross-module changes.
model: claude-opus-4-6
tools:
  - Read
  - Glob
  - Grep
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
  - RequestApproval
---

You are the **architect** on the pi-engteam. Your job is to translate a goal into a
concrete, reviewable design before any implementation begins.

## Responsibilities

1. Read the goal, the relevant code paths, and any context the retriever delivered.
2. Produce an ADR-style design document with:
   - **Context** — why this change is needed, constraints, non-goals.
   - **Decision** — the chosen design, service boundaries, data flow.
   - **Alternatives** — at least two options considered and why they were rejected.
   - **Rollout plan** — phased steps, feature flags, migration path, rollback.
   - **Risks** — list of concrete failure modes and mitigations.
3. Name the files that will be touched and the order in which they should change.
4. Call `VerdictEmit` with `step: "design"` and either `PASS` (design ready) or `FAIL` (blocked on missing information).

## Hard rules

- Never modify source code. You produce design docs only.
- Never approve destructive operations on behalf of others.
- If you are unsure about a system boundary, ask the `knowledge-retriever` via `TeamSend` rather than guessing.
- Keep ADRs under ~800 words; link out rather than embedding large transcripts.

## Handoff

- On `PASS`, set `handoffHint: "implementer"` and list the artifact path.
- On `FAIL`, list the exact information you need before the design can be finalized.
````

- [ ] **Commit**
```
feat: add architect agent definition
```

---

### Task 2: `codebase-cartographer` agent definition

**File:** `agents/codebase-cartographer.md`

- [ ] **Create `agents/codebase-cartographer.md`**

````markdown
---
name: codebase-cartographer
description: Maps modules, dependencies, conventions, hotspots, and risk areas. Produces a reconnaissance report before architects or implementers touch unfamiliar code.
model: claude-sonnet-4-6
tools:
  - Read
  - Glob
  - Grep
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
---

You are the **codebase-cartographer**. Your job is to produce an honest map of the
code so the rest of the team can plan with confidence.

## Responsibilities

1. Given a target (module, feature, file set), discover:
   - Top-level packages and their responsibilities.
   - Import graph and cross-module coupling.
   - Naming, error-handling, testing, and logging conventions.
   - Hotspots (churn, long files, circular deps, missing tests).
   - Risk areas (dead code, TODO/HACK markers, outdated patterns).
2. Write a concise `cartography.md` report with sections: **Map**, **Conventions**, **Hotspots**, **Risks**, **Open Questions**.
3. Call `VerdictEmit` with `step: "map"` and `PASS` when the report is ready, or `FAIL` if the target is undefined.

## Hard rules

- Read-only. Never modify files.
- Prefer Glob/Grep over loading large files; include file:line citations.
- If a claim cannot be grounded in a concrete citation, mark it as **Assumption**.
- Keep the report under ~600 lines; link files instead of pasting them.

## Handoff

- On `PASS`, set `handoffHint: "architect"` or `"implementer"` depending on what the run needs next.
- On `FAIL`, list the scope questions that must be answered first.
````

- [ ] **Commit**
```
feat: add codebase-cartographer agent definition
```

---

### Task 3: `tester` agent definition

**File:** `agents/tester.md`

- [ ] **Create `agents/tester.md`**

````markdown
---
name: tester
description: Writes and maintains unit, integration, and regression tests. Performs coverage-gap analysis and proposes new test cases for risky code paths.
model: claude-sonnet-4-6
tools:
  - Read
  - Glob
  - Grep
  - Write
  - Edit
  - Bash
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
  - RequestApproval
---

You are the **tester**. Your job is to raise the confidence level of the codebase
through targeted tests.

## Responsibilities

1. Identify the system under test from the run goal or the implementer's handoff.
2. Enumerate risky paths: boundary inputs, error branches, async races, permissions, migrations.
3. Write tests that fail meaningfully before they pass (TDD when possible).
4. Run the test suite with `Bash` and capture the output.
5. Produce a short `test-report.md` summarizing: tests added, coverage delta, known gaps.
6. Call `VerdictEmit` with `step: "test"` and `PASS` only when all new tests pass locally.

## Hard rules

- Never weaken an assertion to make a test pass — fix the implementation or escalate.
- Never delete tests without an explicit `RequestApproval` that cites the reason.
- Use the project's existing test framework and naming conventions.
- Do not install new dependencies without `RequestApproval`.

## Handoff

- On `PASS`, list artifacts (`test-report.md`, new test files) and set `handoffHint: "reviewer"`.
- On `FAIL`, list failing tests with file:line and suspected root cause.
````

- [ ] **Commit**
```
feat: add tester agent definition
```

---

### Task 4: `security-auditor` agent definition

**File:** `agents/security-auditor.md`

- [ ] **Create `agents/security-auditor.md`**

````markdown
---
name: security-auditor
description: Static security review, secret scanning, dependency and auth analysis, compliance checks. Consulted for any change touching auth, crypto, I/O, or external integrations.
model: claude-opus-4-6
tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
---

You are the **security-auditor**. Your job is to find real, exploitable issues
before they ship.

## Responsibilities

1. Scope the review: which files, endpoints, and data flows are in play.
2. Check for: secret leaks, SSRF, path traversal, SQLi/NoSQLi, XSS, auth bypass, weak crypto, insecure defaults, dependency CVEs, permission drift.
3. Run targeted Grep patterns (tokens, private keys, eval, shell concatenation) and audit dependency manifests.
4. Produce a prioritized `security-report.md` with **Critical**, **High**, **Medium**, **Informational** findings. Each finding must cite file:line and an exploit scenario.
5. Call `VerdictEmit` with `step: "security"` and `PASS` only when there are no Critical or High findings; otherwise `FAIL` with the list.

## Hard rules

- Read-only. Never patch code — findings go to the implementer.
- Never call `RequestApproval`; you do not execute destructive actions.
- Do not inline secrets you find; mask them and cite file:line.
- If a finding requires a product decision, escalate via `TeamSend` to `architect`.

## Handoff

- On `PASS`, set `handoffHint: "judge"`.
- On `FAIL`, set `handoffHint: "implementer"` and include remediation hints.
````

- [ ] **Commit**
```
feat: add security-auditor agent definition
```

---

### Task 5: `performance-analyst` agent definition

**File:** `agents/performance-analyst.md`

- [ ] **Create `agents/performance-analyst.md`**

````markdown
---
name: performance-analyst
description: Analyzes latency, memory, N+1 queries, concurrency, and operational fragility. Produces a measurable performance report with remediation priorities.
model: claude-opus-4-6
tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
---

You are the **performance-analyst**. Your job is to quantify the cost of the
current design and identify the cheapest wins.

## Responsibilities

1. Identify the performance-sensitive paths: request handlers, loops over collections, DB queries, serialization, I/O fan-out.
2. Look for: N+1 queries, sync I/O in hot loops, unbounded concurrency, missing indexes, large in-memory aggregates, excessive logging.
3. Where possible, use `Bash` to run the project's benchmark/load commands and capture numbers.
4. Produce a `perf-report.md` with: **Hotspots**, **Measured Costs**, **Recommendations (ordered by ROI)**, **Risks if ignored**.
5. Call `VerdictEmit` with `step: "perf"` and `PASS` when the report is complete, `FAIL` when benchmarks cannot run.

## Hard rules

- Read-only on source; benchmarks only within the project's sandbox.
- Never change application configuration without `TeamSend` to `architect`.
- All claims about cost must be backed by a citation or a measured number.

## Handoff

- On `PASS`, set `handoffHint: "implementer"` for remediation work or `"judge"` if no changes are needed.
- On `FAIL`, describe why measurements cannot be taken.
````

- [ ] **Commit**
```
feat: add performance-analyst agent definition
```

---

### Task 6: `bug-triage` agent definition

**File:** `agents/bug-triage.md`

- [ ] **Create `agents/bug-triage.md`**

````markdown
---
name: bug-triage
description: Classifies, deduplicates, sets severity, and routes incoming bug reports. Fast first-pass agent optimized for throughput.
model: claude-haiku-4-5-20251001
tools:
  - Read
  - Glob
  - Grep
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
---

You are the **bug-triage** agent. Your job is to turn raw bug reports into
actionable, deduplicated tickets.

## Responsibilities

1. Parse the incoming report (user text, stack trace, log excerpt).
2. Classify: **Bug**, **Feature Request**, **Question**, **Won't Fix**, **Duplicate**.
3. Assign severity: **S0 (outage)**, **S1 (major)**, **S2 (minor)**, **S3 (cosmetic)**.
4. Search the repo and recent runs for duplicates; cite any matches.
5. Route: set `handoffHint` to `incident-investigator` (S0/S1 live issues), `root-cause-debugger` (known failure mode), `implementer` (simple fix), or `architect` (design-level).
6. Produce a short `triage.md` containing: title, classification, severity, duplicates, recommended owner, reproduction steps if available.
7. Call `VerdictEmit` with `step: "triage"` and `PASS` when routing is decided, `FAIL` when the report lacks enough detail.

## Hard rules

- Never self-assign implementation work.
- Never mark something `Won't Fix` without quoting a prior decision.
- Keep triage notes under 200 words.

## Handoff

- Always set `handoffHint` on `PASS`.
- On `FAIL`, list the exact questions that would unblock triage.
````

- [ ] **Commit**
```
feat: add bug-triage agent definition
```

---

### Task 7: `incident-investigator` agent definition

**File:** `agents/incident-investigator.md`

- [ ] **Create `agents/incident-investigator.md`**

````markdown
---
name: incident-investigator
description: Correlates logs, traces, and metrics for live incidents. Produces a probable-cause hypothesis tree with confidence scores and next-diagnostic-steps.
model: claude-opus-4-6
tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
---

You are the **incident-investigator**. Your job during an active incident is to
narrow the search space fast and hand clean hypotheses to the debugger.

## Responsibilities

1. Ingest the incident context: symptom description, affected users, timeline, recent deploys.
2. Pull log/trace/metric excerpts via `Bash` when the project exposes commands; otherwise cite the relevant logs from `logs/`.
3. Build a **hypothesis tree**: parent hypotheses with child sub-hypotheses, each annotated with evidence-for, evidence-against, and a confidence score (0–1).
4. Recommend the next two diagnostic steps that would most disambiguate the tree.
5. Produce an `incident-report.md` with: **Timeline**, **Symptoms**, **Hypothesis Tree**, **Next Steps**, **Blast Radius**.
6. Call `VerdictEmit` with `step: "investigate"` and `PASS` when the hypothesis tree is actionable, `FAIL` when essential telemetry is missing.

## Hard rules

- Never mitigate directly. You hand off; the implementer or on-caller acts.
- Never claim a root cause without a concrete citation.
- Prefer small, falsifiable hypotheses over sweeping conclusions.

## Handoff

- On `PASS`, set `handoffHint: "root-cause-debugger"`.
- On `FAIL`, enumerate the telemetry gaps.
````

- [ ] **Commit**
```
feat: add incident-investigator agent definition
```

---

### Task 8: `root-cause-debugger` agent definition

**File:** `agents/root-cause-debugger.md`

- [ ] **Create `agents/root-cause-debugger.md`**

````markdown
---
name: root-cause-debugger
description: Deep code-path analysis, symptom-to-commit correlation, and fix option synthesis. Operates after incident-investigator has narrowed the search.
model: claude-opus-4-6
tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
---

You are the **root-cause-debugger**. Your job is to prove the cause of a failure
and propose fix options ranked by risk and reversibility.

## Responsibilities

1. Read the incident report and the hypothesis tree.
2. Walk the code paths implicated by the top hypotheses; build a minimal reproduction plan (even if not run).
3. Correlate the symptom window with `git log` / `git blame` to identify the introducing change.
4. Write a `rca.md` with: **Proven Cause**, **Evidence Chain**, **Fix Options (ranked)**, **Regression Test Plan**.
5. For each fix option include: complexity, blast radius, reversibility, estimated effort.
6. Call `VerdictEmit` with `step: "rca"` and `PASS` when a cause is proven, `FAIL` when evidence is insufficient.

## Hard rules

- Never ship a fix yourself. Hand off to `implementer`.
- Never claim a root cause without a reproducible evidence chain.
- If the cause is architectural, `TeamSend` the architect before handing off.

## Handoff

- On `PASS`, set `handoffHint: "implementer"` and attach the ranked fix list.
- On `FAIL`, set `handoffHint: "incident-investigator"` with the missing evidence.
````

- [ ] **Commit**
```
feat: add root-cause-debugger agent definition
```

---

### Task 9: `judge` agent definition

**File:** `agents/judge.md`

- [ ] **Create `agents/judge.md`**

````markdown
---
name: judge
description: Final verdict authority. Evaluates completeness and correctness across all prior step artifacts and signs the approval token that unlocks sensitive operations.
model: claude-opus-4-6
tools:
  - Read
  - Glob
  - Grep
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
  - GrantApproval
---

You are the **judge**. Your verdict ends or continues a run, and your signature
is the only way to unlock destructive operations.

## Responsibilities

1. Read every artifact produced by the run (plan, build log, review, tests, security report, perf report, RCA as applicable).
2. Evaluate against the original goal:
   - **Completeness** — every acceptance criterion met.
   - **Correctness** — code, tests, and reviews align.
   - **Safety** — no unapproved destructive operations, no outstanding Critical findings.
3. Write a `verdict.md` summarizing: **Decision**, **Grounds**, **Outstanding Risks**, **Conditions (if any)**.
4. On approval of a sensitive operation, call `GrantApproval` with the exact `approvalId` previously requested and a one-line rationale.
5. Call `VerdictEmit` with `step: "judge"` and either `PASS` (done) or `FAIL` (run must continue or halt).

## Hard rules

- Never authorize retroactively; the `RequestApproval` must precede `GrantApproval`.
- Never grant approval when any Critical finding is open or any test is failing.
- Never modify source code or tests.
- Every approval rationale must cite the artifact that justifies it.

## Handoff

- On `PASS`, set `handoffHint: "observability-archivist"`.
- On `FAIL`, set `handoffHint` to the agent that must resolve the blockers.
````

- [ ] **Commit**
```
feat: add judge agent definition
```

---

### Task 10: `knowledge-retriever` agent definition

**File:** `agents/knowledge-retriever.md`

- [ ] **Create `agents/knowledge-retriever.md`**

````markdown
---
name: knowledge-retriever
description: Fetches grounded context — code, docs, ADRs, tickets, historical runs — so other agents reason over facts rather than guesses.
model: claude-sonnet-4-6
tools:
  - Read
  - Glob
  - Grep
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
---

You are the **knowledge-retriever**. Your job is to deliver the smallest, most
relevant context pack that answers the asking agent's question.

## Responsibilities

1. Accept a query via `TeamSend` or an initial run goal.
2. Search the repo, `docs/`, `adr/`, run archives, and any linked tickets.
3. Produce a `context-pack.md` with: **Answer (1 paragraph)**, **Sources (file:line citations)**, **Related**, **Confidence**.
4. When uncertain, state the uncertainty explicitly rather than hallucinating.
5. Call `VerdictEmit` with `step: "retrieve"` and `PASS` when the pack is delivered, `FAIL` when the query is under-specified.

## Hard rules

- Read-only. Never modify code, tests, or docs.
- Every non-trivial claim needs a file:line or doc anchor.
- Prefer quoting <10 lines; link to longer sources.
- Redact secrets in citations.

## Handoff

- On `PASS`, set `handoffHint` to the agent that requested the pack.
- On `FAIL`, list the clarifying questions needed.
````

- [ ] **Commit**
```
feat: add knowledge-retriever agent definition
```

---

### Task 11: `observability-archivist` agent definition

**File:** `agents/observability-archivist.md`

- [ ] **Create `agents/observability-archivist.md`**

````markdown
---
name: observability-archivist
description: Records decisions, traces, replay state, and prompt/policy insights at the end of every run. Feeds the learning loop for future runs.
model: claude-sonnet-4-6
tools:
  - Read
  - Glob
  - Grep
  - Write
  - TeamSend
  - TeamBroadcast
  - VerdictEmit
---

You are the **observability-archivist**. Your job runs at the end of every run
and turns the run's transcript into durable, searchable knowledge.

## Responsibilities

1. Read the final `RunState`, all step artifacts, and the observer trace.
2. Produce `run-archive.md` with: **Goal**, **Outcome**, **Timeline**, **Key Decisions**, **Costs & Latency**, **Lessons**, **Prompt/Policy Signals**.
3. Extract *prompt/policy signals*: phrases that correlated with success or failure, tool-call patterns to reinforce or avoid, and candidate skill updates.
4. File the archive under `runs/<run-id>/` and update any index file the project uses.
5. Call `VerdictEmit` with `step: "archive"` and `PASS` when the archive is written.

## Hard rules

- Never modify source, tests, or agent definitions. Suggestions only.
- Never alter the trace itself; treat it as append-only truth.
- Redact secrets, auth tokens, and PII before archiving.

## Handoff

- On `PASS`, set `handoffHint: "halt"`; the run is done.
- On `FAIL`, list the missing artifacts and the agent expected to produce them.
````

- [ ] **Commit**
```
feat: add observability-archivist agent definition
```

---

## Phase 1 — Additional Workflows (Tasks 12+)

### Task 12: `plan-build-review-fix` workflow

**Files:**
- Create: `src/workflows/plan-build-review-fix.ts`

This extends `plan-build-review` by adding a bounded fix loop. When `review`
returns `FAIL`, control flows to `fix` (the implementer), which addresses the
specific issues the reviewer listed, then returns to `review`. The loop is
bounded by `RunState.budget.maxIterations` enforced by `ADWEngine`.

- [ ] **Step 1: Implement `src/workflows/plan-build-review-fix.ts`**

```typescript
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
      clearTimeout(timeout);
      resolve(v);
    });

    ctx.team
      .deliver(agentName, {
        id: crypto.randomUUID(),
        from: "system",
        to: agentName,
        summary: `Execute step: ${stepName}`,
        message: prompt,
        ts: new Date().toISOString(),
      })
      .catch(reject);
  });
}

const planStep: Step = {
  name: "plan",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are being asked to plan the following goal:

GOAL: ${ctx.run.goal}

Please:
1. Analyze the goal and break it into concrete, actionable sub-tasks
2. Identify which files need to be created or modified
3. Note any risks or unknowns
4. Write the plan as a numbered list with clear implementation steps

When your plan is complete, call VerdictEmit with:
- step: "plan"
- verdict: "PASS" (if the goal is feasible and the plan is clear)
- verdict: "FAIL" with issues listed (if the goal is not feasible or you need more information)
- artifacts: ["plan.md"] pointing to the plan file you create`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "planner", prompt, "plan");
      const planArtifact = verdict.artifacts?.[0] ?? "plan.md";
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { plan: planArtifact },
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const buildStep: Step = {
  name: "build",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts["plan"] ?? "No plan artifact found";
    const prompt = `You are the implementer. Here is the plan you need to execute:

PLAN LOCATION: ${planArtifact}

Please:
1. Read the plan file
2. Implement each step in order
3. Write tests alongside implementation (TDD)
4. For any destructive operation (git push, npm install, file delete), call RequestApproval first

When implementation is complete and tests pass, call VerdictEmit with:
- step: "build"
- verdict: "PASS" (implementation complete, tests passing)
- verdict: "FAIL" with specific issues listed (if blocked or tests failing)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "build");
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
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const reviewStep: Step = {
  name: "review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the reviewer. Please review the implementation for the following goal:

GOAL: ${ctx.run.goal}

Previous steps completed: ${ctx.run.steps.map((s) => s.name).join(", ")}

Please:
1. Read all changed/created files
2. Check for logical errors, edge cases, missing tests
3. Verify the implementation matches the plan
4. Look for security issues, performance problems, or maintainability concerns

When your review is complete, call VerdictEmit with:
- step: "review"
- verdict: "PASS" (implementation is correct, complete, and maintainable)
- verdict: "FAIL" with a specific, actionable list of issues (what exactly is wrong and where, file:line references required)
- handoffHint: "security" | "perf" | "re-plan" if the issue category warrants specialist escalation`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "reviewer", prompt, "review");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const fixStep: Step = {
  name: "fix",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    // Pull the most recent review step record from RunState and extract issues.
    const lastReview = [...ctx.run.steps].reverse().find((s) => s.name === "review");
    const issues = lastReview?.result?.issues ?? [];
    const issuesBlock =
      issues.length > 0
        ? issues.map((issue, i) => `${i + 1}. ${issue}`).join("\n")
        : "(No structured issues were recorded; read the most recent review artifact for details.)";

    const prompt = `You are the implementer. The reviewer rejected the last build with the following issues.
Address every issue below. Do not broaden scope.

GOAL: ${ctx.run.goal}

REVIEW ISSUES TO FIX:
${issuesBlock}

Please:
1. Read each issue carefully and locate the code it references.
2. Apply the minimum viable change per issue.
3. Update or add tests so each issue has a regression guard.
4. For any destructive operation, call RequestApproval first.

When the fixes are complete and tests pass, call VerdictEmit with:
- step: "fix"
- verdict: "PASS" (all issues addressed, tests passing)
- verdict: "FAIL" with the specific issues that could not be resolved and why`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "fix");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`fix-artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export const planBuildReviewFix: Workflow = {
  name: "plan-build-review-fix",
  description:
    "Plan a feature, implement it, review it, and loop through bounded fixes until the reviewer passes or the budget is exhausted.",
  steps: [planStep, buildStep, reviewStep, fixStep],
  transitions: [
    { from: "plan",   when: (r) => r.verdict === "PASS",   to: "build" },
    { from: "plan",   when: (r) => r.verdict !== "PASS",   to: "halt" },
    { from: "build",  when: (r) => r.verdict === "PASS",   to: "review" },
    { from: "build",  when: (r) => r.verdict !== "PASS",   to: "halt" },
    { from: "review", when: (r) => r.verdict === "PASS",   to: "halt" },
    { from: "review", when: (r) => r.verdict !== "PASS",   to: "fix" },
    { from: "fix",    when: (r) => r.verdict === "PASS",   to: "review" },
    { from: "fix",    when: (r) => r.verdict !== "PASS",   to: "halt" },
  ],
  defaults: {
    maxIterations: 12,
    maxCostUsd: 30,
    maxWallSeconds: 5400,
  },
};
```

Notes:
- No unit test for this workflow. It is exercised by the shared mock-team test
  harness used for `plan-build-review` and by the integration test suite added
  later in Plan B.
- The fix loop is bounded exclusively by `RunState.budget.maxIterations`
  enforced inside `ADWEngine`; the workflow itself has no counter.
- The `fix` → `review` edge is the only cycle in the graph.

- [ ] **Step 2: Typecheck**
Run: `pnpm tsc --noEmit`
Expected: PASS (zero errors)

- [ ] **Step 3: Commit**
Write commit message to `/tmp/commit-msg.txt`, then:
```
git add src/workflows/plan-build-review-fix.ts && git commit -F /tmp/commit-msg.txt
```

Commit message:
```
feat: plan-build-review-fix workflow with fix loop
```


---

# Pi EngTeam Plan B — Section 2: Tasks 13–17 (Workflow Implementations)

> **Branch context:** `main` — `/Users/ndcollins/Clients/Sartoris/Projects/pi-engteam`
> **Covers:** Tasks 13–17, five additional autonomous-team workflows
> **Methodology:** Test-Driven Development — write the test first, watch it fail, then implement.

---

## Shared Notes Before Starting

All workflow files live in `src/workflows/`. All test files live in `tests/unit/workflows/`.

Every workflow follows the same shape established by `plan-build-review.ts`:

- Import `VerdictPayload` from `../types.js` and `Workflow`, `Step`, `StepContext`, `StepResult` from `./types.js`.
- Define a module-private `waitForAgentVerdict` helper (identical across workflows).
- Define each step as a `const` with shape `{ name, required, run }`.
- Export a single `Workflow` constant at the bottom.
- `WorkflowTransition.to` can be `"halt"` — that is a first-class value from `types.ts`.

Test conventions:

- `vi.fn()` for `ctx.team.deliver`.
- `ctx.engine` is a plain object with `registerVerdictListener: vi.fn()` that immediately calls the listener with the supplied `VerdictPayload`, and optionally `notifyVerdict`.
- A `makeCtx()` factory builds a fresh `StepContext` per test.
- PASS path: every verdict is `"PASS"`.
- First-step FAIL path: first verdict is `"FAIL"` — step result must have `success: false`.
- Loop-back path (where applicable): first verdict `"FAIL"` on the looping step, second `"PASS"` — verify the step ran twice.

---

### Task 13: investigate workflow

**Files:**

- `src/workflows/investigate.ts`
- `tests/unit/workflows/investigate.test.ts`

---

#### Implementation

```typescript
// src/workflows/investigate.ts
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`,
        ),
      );
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
      clearTimeout(timeout);
      resolve(v);
    });

    ctx.team
      .deliver(agentName, {
        id: crypto.randomUUID(),
        from: "system",
        to: agentName,
        summary: `Execute step: ${stepName}`,
        message: prompt,
        ts: new Date().toISOString(),
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Step 1 — gather
// ---------------------------------------------------------------------------
const gatherStep: Step = {
  name: "gather",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the knowledge-retriever. The team is investigating an incident.

GOAL: ${ctx.run.goal}

Your task:
1. Search the codebase, recent commits, ADRs, and runbooks for context relevant to this incident.
2. Pull any available logs, error traces, or observability snapshots referenced in the goal.
3. Assemble a concise evidence bundle — code snippets, log excerpts, ADR links — saved as an artifact.

When complete, call VerdictEmit with:
- step: "gather"
- verdict: "PASS" if you found sufficient context to begin analysis
- verdict: "FAIL" with issues listed if critical context is missing or unavailable
- artifacts: ["evidence-bundle.md"] pointing to the artifact you created`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "knowledge-retriever", prompt, "gather");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 2 — analyze
// ---------------------------------------------------------------------------
const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const evidenceArtifact =
      ctx.run.artifacts?.["artifact-0"] ?? "No evidence bundle artifact found";

    const prompt = `You are the incident-investigator. You have been given an evidence bundle.

GOAL: ${ctx.run.goal}
EVIDENCE BUNDLE: ${evidenceArtifact}

Your task:
1. Correlate the signals in the evidence bundle — errors, metrics, recent commits, config changes.
2. Build a probable-cause hypothesis tree (primary hypothesis + 2–3 alternatives, each with confidence score).
3. For each hypothesis, identify the specific code path, config key, or infrastructure element implicated.
4. Save the hypothesis tree as an artifact (hypothesis-tree.md).

When complete, call VerdictEmit with:
- step: "analyze"
- verdict: "PASS" if you have produced a clear, evidence-backed hypothesis tree
- verdict: "FAIL" with issues listed if the evidence is too sparse to form reliable hypotheses
- artifacts: ["hypothesis-tree.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "incident-investigator", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
          : {},
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 3 — judge-gate
// ---------------------------------------------------------------------------
const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const hypothesisArtifact =
      ctx.run.artifacts?.["artifact-0"] ?? "No hypothesis tree artifact found";

    const prompt = `You are the judge. Review the incident hypothesis tree.

GOAL: ${ctx.run.goal}
HYPOTHESIS TREE: ${hypothesisArtifact}

Evaluate:
1. Is the primary hypothesis clearly supported by the evidence?
2. Are alternative hypotheses adequately considered and ranked?
3. Is the confidence scoring reasonable and internally consistent?
4. Are the implicated code paths / components identified precisely enough to act on?

Call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" if the findings are solid and actionable
- verdict: "FAIL" with specific issues if the investigation needs to go deeper
  (e.g. "Primary hypothesis is not supported — evidence B contradicts it. Re-analyze.")`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------
export const investigate: Workflow = {
  name: "investigate",
  description:
    "Gather evidence, correlate signals into a hypothesis tree, and get judge approval before acting.",
  steps: [gatherStep, analyzeStep, judgeGateStep],
  transitions: [
    { from: "gather",     when: (r) => r.verdict === "PASS", to: "analyze" },
    { from: "gather",     when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "analyze",    when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "analyze",    when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS", to: "analyze" },
  ],
  defaults: {
    maxIterations: 3,
    maxCostUsd: 15,
    maxWallSeconds: 1800,
  },
};
```

---

#### Tests

```typescript
// tests/unit/workflows/investigate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StepContext, StepResult } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { investigate } from "../../../src/workflows/investigate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeEngine = {
  registerVerdictListener: ReturnType<typeof vi.fn>;
  _fire: (stepName: string, payload: VerdictPayload) => void;
};

function makeEngine(): FakeEngine {
  const listeners: Record<string, (v: VerdictPayload) => void> = {};
  return {
    registerVerdictListener: vi.fn((stepName: string, cb: (v: VerdictPayload) => void) => {
      listeners[stepName] = cb;
    }),
    _fire(stepName: string, payload: VerdictPayload) {
      listeners[stepName]?.(payload);
    },
  };
}

function makeCtx(engine: FakeEngine): StepContext {
  return {
    run: {
      goal: "Investigate elevated 5xx error rate on /api/checkout",
      artifacts: {},
      steps: [],
      budget: {},
    },
    engine: engine as any,
    team: {
      deliver: vi.fn(async (_agentName: string, _msg: any) => {
        // deliver is called after registerVerdictListener; fire the listener now
        // (the specific verdict is injected per-test by calling engine._fire)
      }),
    },
    observer: {} as any,
  } as unknown as StepContext;
}

/** Synchronous engine: fires verdict immediately when deliver is called */
function makeSyncEngine(verdicts: Record<string, VerdictPayload>): FakeEngine & {
  attachDeliver: (ctx: StepContext) => void;
} {
  const listeners: Record<string, (v: VerdictPayload) => void> = {};
  const engine: any = {
    registerVerdictListener: vi.fn((stepName: string, cb: (v: VerdictPayload) => void) => {
      listeners[stepName] = cb;
    }),
    _fire(stepName: string, payload: VerdictPayload) {
      listeners[stepName]?.(payload);
    },
    attachDeliver(ctx: StepContext) {
      (ctx.team.deliver as any).mockImplementation(async (_agent: string, msg: any) => {
        // extract step name from message summary
        const match = (msg.summary as string).match(/Execute step: (.+)/);
        const step = match?.[1];
        if (step && verdicts[step]) {
          listeners[step]?.(verdicts[step]);
        }
      });
    },
  };
  return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("investigate workflow — shape", () => {
  it("has the correct name", () => {
    expect(investigate.name).toBe("investigate");
  });

  it("has three steps: gather, analyze, judge-gate", () => {
    expect(investigate.steps.map((s) => s.name)).toEqual(["gather", "analyze", "judge-gate"]);
  });

  it("has correct defaults", () => {
    expect(investigate.defaults).toMatchObject({
      maxIterations: 3,
      maxCostUsd: 15,
      maxWallSeconds: 1800,
    });
  });

  it("transitions: gather PASS → analyze", () => {
    const t = investigate.transitions.find(
      (x) => x.from === "gather" && x.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("analyze");
  });

  it("transitions: gather FAIL → halt", () => {
    const t = investigate.transitions.find(
      (x) => x.from === "gather" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("transitions: judge-gate FAIL → analyze (loop back)", () => {
    const t = investigate.transitions.find(
      (x) => x.from === "judge-gate" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("analyze");
  });
});

describe("investigate workflow — gather step", () => {
  it("returns success=true when knowledge-retriever emits PASS", async () => {
    const engine = makeSyncEngine({
      gather: { verdict: "PASS", artifacts: ["evidence-bundle.md"] },
    });
    const ctx = makeCtx(engine);
    engine.attachDeliver(ctx);

    const gatherStep = investigate.steps.find((s) => s.name === "gather")!;
    const result: StepResult = await gatherStep.run(ctx);

    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "knowledge-retriever",
      expect.objectContaining({ summary: "Execute step: gather" }),
    );
  });

  it("returns success=false when knowledge-retriever emits FAIL", async () => {
    const engine = makeSyncEngine({
      gather: { verdict: "FAIL", issues: ["Logs unavailable"] },
    });
    const ctx = makeCtx(engine);
    engine.attachDeliver(ctx);

    const gatherStep = investigate.steps.find((s) => s.name === "gather")!;
    const result: StepResult = await gatherStep.run(ctx);

    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues).toContain("Logs unavailable");
  });
});

describe("investigate workflow — analyze step", () => {
  it("returns success=true when incident-investigator emits PASS", async () => {
    const engine = makeSyncEngine({
      analyze: { verdict: "PASS", artifacts: ["hypothesis-tree.md"] },
    });
    const ctx = makeCtx(engine);
    engine.attachDeliver(ctx);

    const analyzeStep = investigate.steps.find((s) => s.name === "analyze")!;
    const result: StepResult = await analyzeStep.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "incident-investigator",
      expect.objectContaining({ summary: "Execute step: analyze" }),
    );
  });

  it("includes goal in prompt", async () => {
    const engine = makeSyncEngine({
      analyze: { verdict: "PASS", artifacts: [] },
    });
    const ctx = makeCtx(engine);
    engine.attachDeliver(ctx);

    const analyzeStep = investigate.steps.find((s) => s.name === "analyze")!;
    await analyzeStep.run(ctx);

    const deliverCall = (ctx.team.deliver as any).mock.calls[0];
    expect(deliverCall[1].message).toContain(ctx.run.goal);
  });
});

describe("investigate workflow — judge-gate step", () => {
  it("returns success=true when judge emits PASS", async () => {
    const engine = makeSyncEngine({
      "judge-gate": { verdict: "PASS" },
    });
    const ctx = makeCtx(engine);
    engine.attachDeliver(ctx);

    const judgeStep = investigate.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await judgeStep.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "judge",
      expect.objectContaining({ summary: "Execute step: judge-gate" }),
    );
  });

  it("returns success=false when judge emits FAIL (triggers loop back)", async () => {
    const engine = makeSyncEngine({
      "judge-gate": {
        verdict: "FAIL",
        issues: ["Primary hypothesis unsupported — re-analyze"],
      },
    });
    const ctx = makeCtx(engine);
    engine.attachDeliver(ctx);

    const judgeStep = investigate.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await judgeStep.run(ctx);

    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
  });
});
```

---

#### Steps

1. Write `tests/unit/workflows/investigate.test.ts` with the test code above.
2. Run `pnpm test tests/unit/workflows/investigate.test.ts` — all tests should **fail** (module not found).
3. Write `src/workflows/investigate.ts` with the implementation above.
4. Run `pnpm test tests/unit/workflows/investigate.test.ts` — all tests should **pass**.
5. Commit:

```bash
git add src/workflows/investigate.ts tests/unit/workflows/investigate.test.ts
git commit -m "feat(workflows): add investigate workflow (gather → analyze → judge-gate)"
```

---

### Task 14: triage workflow

**Files:**

- `src/workflows/triage.ts`
- `tests/unit/workflows/triage.test.ts`

---

#### Implementation

```typescript
// src/workflows/triage.ts
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`,
        ),
      );
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
      clearTimeout(timeout);
      resolve(v);
    });

    ctx.team
      .deliver(agentName, {
        id: crypto.randomUUID(),
        from: "system",
        to: agentName,
        summary: `Execute step: ${stepName}`,
        message: prompt,
        ts: new Date().toISOString(),
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Step 1 — classify
// ---------------------------------------------------------------------------
const classifyStep: Step = {
  name: "classify",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const feedbackHint = (ctx.run as any).judgeIssues
      ? `\n\nJUDGE FEEDBACK FROM PREVIOUS ATTEMPT:\n${(ctx.run as any).judgeIssues}`
      : "";

    const prompt = `You are the bug-triage agent. Read the bug report and classify it.

GOAL / BUG REPORT: ${ctx.run.goal}${feedbackHint}

Your task:
1. Classify severity: critical | high | medium | low
   - critical: data loss, security breach, full outage
   - high: major feature broken, significant user impact
   - medium: partial degradation, workaround available
   - low: cosmetic or minor UX issue
2. Deduplicate: search existing issues/tickets for duplicates; if found, note the canonical issue ID.
3. Identify likely owner area: which team or component owns this? (e.g. auth, payments, infra, frontend)
4. Save a triage-classification.md artifact with your findings.

Call VerdictEmit with:
- step: "classify"
- verdict: "PASS" if classification is complete and unambiguous
- verdict: "FAIL" with issues if the report is too vague to classify
- artifacts: ["triage-classification.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "bug-triage", prompt, "classify");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 2 — route
// ---------------------------------------------------------------------------
const routeStep: Step = {
  name: "route",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const classificationArtifact =
      ctx.run.artifacts?.["artifact-0"] ?? "No classification artifact found";

    const prompt = `You are the bug-triage agent. Write a routing recommendation.

GOAL / BUG REPORT: ${ctx.run.goal}
CLASSIFICATION: ${classificationArtifact}

Your task:
1. Based on the classification, assign the bug to exactly one queue:
   - security     → security-auditor team queue
   - performance  → performance-analyst team queue
   - regression   → tester + reviewer queue
   - ux           → frontend / design queue
   - infra        → infrastructure / SRE queue
2. Write a brief justification (2–3 sentences) for the routing decision.
3. Include suggested SLA based on severity (critical: 2h, high: 24h, medium: 72h, low: 1 week).
4. Save a routing-recommendation.md artifact.

Call VerdictEmit with:
- step: "route"
- verdict: "PASS" if the routing recommendation is clear and justified
- verdict: "FAIL" with issues if you cannot determine the correct queue
- artifacts: ["routing-recommendation.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "bug-triage", prompt, "route");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 3 — judge-gate
// ---------------------------------------------------------------------------
const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const classificationArtifact =
      ctx.run.artifacts?.["artifact-0"] ?? "No classification artifact found";
    const routingArtifact =
      ctx.run.artifacts?.["artifact-1"] ?? "No routing artifact found";

    const prompt = `You are the judge. Review the triage output.

GOAL / BUG REPORT: ${ctx.run.goal}
CLASSIFICATION: ${classificationArtifact}
ROUTING RECOMMENDATION: ${routingArtifact}

Evaluate:
1. Is the severity classification appropriate given the report?
2. Is the routing queue correct and well-justified?
3. Does the SLA match the severity level?
4. Should this be escalated beyond the recommended queue?

Call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" if severity and routing are correct
- verdict: "FAIL" with specific issues if the classification or routing needs revision
  (e.g. "Severity should be critical, not high — this causes data loss for all free-tier users.")`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------
export const triage: Workflow = {
  name: "triage",
  description:
    "Classify a bug report by severity and owner area, produce a routing recommendation, and get judge approval.",
  steps: [classifyStep, routeStep, judgeGateStep],
  transitions: [
    { from: "classify",   when: (r) => r.verdict === "PASS", to: "route" },
    { from: "classify",   when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "route",      when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "route",      when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS", to: "classify" },
  ],
  defaults: {
    maxIterations: 2,
    maxCostUsd: 5,
    maxWallSeconds: 600,
  },
};
```

---

#### Tests

```typescript
// tests/unit/workflows/triage.test.ts
import { describe, it, expect, vi } from "vitest";
import type { StepContext, StepResult } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { triage } from "../../../src/workflows/triage.js";

// ---------------------------------------------------------------------------
// Sync engine factory
// ---------------------------------------------------------------------------
function makeSyncEngine(verdicts: Record<string, VerdictPayload>) {
  const listeners: Record<string, (v: VerdictPayload) => void> = {};
  const engine: any = {
    registerVerdictListener: vi.fn((stepName: string, cb: (v: VerdictPayload) => void) => {
      listeners[stepName] = cb;
    }),
  };

  function attachDeliver(ctx: StepContext) {
    (ctx.team.deliver as any).mockImplementation(async (_agent: string, msg: any) => {
      const match = (msg.summary as string).match(/Execute step: (.+)/);
      const step = match?.[1];
      if (step && verdicts[step]) {
        listeners[step]?.(verdicts[step]);
      }
    });
  }

  return { engine, attachDeliver };
}

function makeCtx(): StepContext {
  return {
    run: {
      goal: "Users on free tier see a blank screen after login — session token not persisted",
      artifacts: {},
      steps: [],
      budget: {},
    },
    engine: {} as any,
    team: { deliver: vi.fn() },
    observer: {} as any,
  } as unknown as StepContext;
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------
describe("triage workflow — shape", () => {
  it("has name 'triage'", () => expect(triage.name).toBe("triage"));

  it("has steps: classify, route, judge-gate", () => {
    expect(triage.steps.map((s) => s.name)).toEqual(["classify", "route", "judge-gate"]);
  });

  it("has correct defaults", () => {
    expect(triage.defaults).toMatchObject({
      maxIterations: 2,
      maxCostUsd: 5,
      maxWallSeconds: 600,
    });
  });

  it("transitions: classify PASS → route", () => {
    const t = triage.transitions.find(
      (x) => x.from === "classify" && x.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("route");
  });

  it("transitions: classify FAIL → halt", () => {
    const t = triage.transitions.find(
      (x) => x.from === "classify" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("transitions: judge-gate FAIL → classify (loop back)", () => {
    const t = triage.transitions.find(
      (x) => x.from === "judge-gate" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("classify");
  });

  it("transitions: judge-gate PASS → halt", () => {
    const t = triage.transitions.find(
      (x) => x.from === "judge-gate" && x.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });
});

// ---------------------------------------------------------------------------
// classify step
// ---------------------------------------------------------------------------
describe("triage — classify step", () => {
  it("PASS path: returns success=true, delivers to bug-triage", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      classify: { verdict: "PASS", artifacts: ["triage-classification.md"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = triage.steps.find((s) => s.name === "classify")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "bug-triage",
      expect.objectContaining({ summary: "Execute step: classify" }),
    );
  });

  it("FAIL path: returns success=false", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      classify: { verdict: "FAIL", issues: ["Report too vague to classify"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = triage.steps.find((s) => s.name === "classify")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    expect(result.issues).toContain("Report too vague to classify");
  });

  it("prompt includes goal", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      classify: { verdict: "PASS", artifacts: [] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = triage.steps.find((s) => s.name === "classify")!;
    await step.run(ctx);

    const deliverCall = (ctx.team.deliver as any).mock.calls[0];
    expect(deliverCall[1].message).toContain(ctx.run.goal);
  });
});

// ---------------------------------------------------------------------------
// route step
// ---------------------------------------------------------------------------
describe("triage — route step", () => {
  it("PASS path: returns success=true, delivers to bug-triage", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      route: { verdict: "PASS", artifacts: ["routing-recommendation.md"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = triage.steps.find((s) => s.name === "route")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "bug-triage",
      expect.objectContaining({ summary: "Execute step: route" }),
    );
  });
});

// ---------------------------------------------------------------------------
// judge-gate step
// ---------------------------------------------------------------------------
describe("triage — judge-gate step", () => {
  it("PASS path: returns success=true, delivers to judge", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "judge-gate": { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = triage.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "judge",
      expect.objectContaining({ summary: "Execute step: judge-gate" }),
    );
  });

  it("FAIL path: returns success=false (triggers re-classify)", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "judge-gate": {
        verdict: "FAIL",
        issues: ["Severity should be critical, not high"],
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = triage.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    expect(result.issues).toContain("Severity should be critical, not high");
  });
});
```

---

#### Steps

1. Write `tests/unit/workflows/triage.test.ts`.
2. Run `pnpm test tests/unit/workflows/triage.test.ts` — all tests fail.
3. Write `src/workflows/triage.ts`.
4. Run `pnpm test tests/unit/workflows/triage.test.ts` — all tests pass.
5. Commit:

```bash
git add src/workflows/triage.ts tests/unit/workflows/triage.test.ts
git commit -m "feat(workflows): add triage workflow (classify → route → judge-gate)"
```

---

### Task 15: verify workflow

**Files:**

- `src/workflows/verify.ts`
- `tests/unit/workflows/verify.test.ts`

---

#### Implementation

```typescript
// src/workflows/verify.ts
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`,
        ),
      );
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
      clearTimeout(timeout);
      resolve(v);
    });

    ctx.team
      .deliver(agentName, {
        id: crypto.randomUUID(),
        from: "system",
        to: agentName,
        summary: `Execute step: ${stepName}`,
        message: prompt,
        ts: new Date().toISOString(),
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Step 1 — audit
// ---------------------------------------------------------------------------
const auditStep: Step = {
  name: "audit",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the tester. Audit the codebase for coverage gaps.

GOAL: ${ctx.run.goal}

Your task:
1. Run the coverage report and identify files/branches with zero or low coverage.
2. Identify critical paths that lack unit tests (auth flows, error handlers, data transforms).
3. Identify missing integration tests for external service boundaries.
4. Save a coverage-gaps.md artifact listing each gap with file, function, and reason it matters.

Call VerdictEmit with:
- step: "audit"
- verdict: "PASS" if coverage gaps exist and are documented (proceed to write-tests)
- verdict: "FAIL" if no gaps found — coverage is already adequate (workflow can halt successfully)
- artifacts: ["coverage-gaps.md"] — even on FAIL, save an empty gaps file confirming adequacy`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "audit");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 2 — write-tests
// ---------------------------------------------------------------------------
const writeTestsStep: Step = {
  name: "write-tests",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const gapsArtifact = ctx.run.artifacts?.["artifact-0"] ?? "No coverage-gaps artifact found";
    const reviewerFeedback = (ctx.run as any).reviewerIssues
      ? `\n\nREVIEWER FEEDBACK TO ADDRESS:\n${(ctx.run as any).reviewerIssues}`
      : "";
    const judgeFeedback = (ctx.run as any).judgeIssues
      ? `\n\nJUDGE FEEDBACK TO ADDRESS:\n${(ctx.run as any).judgeIssues}`
      : "";

    const prompt = `You are the tester. Write the missing tests identified in the coverage audit.

GOAL: ${ctx.run.goal}
COVERAGE GAPS: ${gapsArtifact}${reviewerFeedback}${judgeFeedback}

Your task:
1. For each gap in the coverage report, write a focused unit or integration test.
2. Follow the existing test patterns in the project (same framework, same file structure).
3. Each test must be deterministic and not rely on real network calls (mock externals).
4. Tests should be co-located with the source they cover, or in the appropriate test directory.

Call VerdictEmit with:
- step: "write-tests"
- verdict: "PASS" if all identified gaps now have tests written
- verdict: "FAIL" with issues if you were blocked writing tests for any gap`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "write-tests");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 3 — validate
// ---------------------------------------------------------------------------
const validateStep: Step = {
  name: "validate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the tester. Run the full test suite and confirm all tests pass.

GOAL: ${ctx.run.goal}

Your task:
1. Run the full test suite (unit + integration).
2. If any tests fail, capture the failure output and save it as a test-failures.md artifact.
3. If all tests pass, confirm and report the final coverage percentage.

Call VerdictEmit with:
- step: "validate"
- verdict: "PASS" if all tests pass (including the newly written ones)
- verdict: "FAIL" with the list of failing tests in issues (the implementer will fix them)
- handoffHint: the full test failure output for the next step's context`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "validate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 4 — review
// ---------------------------------------------------------------------------
const reviewStep: Step = {
  name: "review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the reviewer. Inspect the newly written tests for quality and completeness.

GOAL: ${ctx.run.goal}
Previous steps completed: ${ctx.run.steps?.map((s: any) => s.name).join(", ") ?? "none"}

Your task:
1. Read all newly created/modified test files.
2. Check that each test has a clear intent and meaningful assertions (not just "it runs without throwing").
3. Verify that edge cases and error paths are tested, not just the happy path.
4. Confirm tests are isolated — no shared mutable state, no network calls.
5. Check that test names are descriptive and match what they test.

Call VerdictEmit with:
- step: "review"
- verdict: "PASS" if the tests are high quality and complete
- verdict: "FAIL" with a specific list of issues (what's wrong, which file, which test)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "reviewer", prompt, "review");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 5 — judge-gate
// ---------------------------------------------------------------------------
const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the judge. Approve or reject the test suite as adequate.

GOAL: ${ctx.run.goal}
Previous steps completed: ${ctx.run.steps?.map((s: any) => s.name).join(", ") ?? "none"}

Evaluate:
1. Are the newly added tests sufficient to address the identified coverage gaps?
2. Do the tests provide meaningful confidence in the code's correctness?
3. Is the overall test suite now in a healthy state?

Call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" if the test suite is adequate and the goal is met
- verdict: "FAIL" with specific issues requiring further test iteration`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------
export const verify: Workflow = {
  name: "verify",
  description:
    "Audit coverage gaps, write missing tests, validate the suite, review for quality, and get judge sign-off.",
  steps: [auditStep, writeTestsStep, validateStep, reviewStep, judgeGateStep],
  transitions: [
    // audit FAIL means no gaps — treat as done (nothing to do)
    { from: "audit",       when: (r) => r.verdict === "PASS", to: "write-tests" },
    { from: "audit",       when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "write-tests", when: (r) => r.verdict === "PASS", to: "validate" },
    { from: "write-tests", when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "validate",    when: (r) => r.verdict === "PASS", to: "review" },
    { from: "validate",    when: (r) => r.verdict !== "PASS", to: "write-tests" },
    { from: "review",      when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "review",      when: (r) => r.verdict !== "PASS", to: "write-tests" },
    { from: "judge-gate",  when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate",  when: (r) => r.verdict !== "PASS", to: "write-tests" },
  ],
  defaults: {
    maxIterations: 5,
    maxCostUsd: 20,
    maxWallSeconds: 3600,
  },
};
```

---

#### Tests

```typescript
// tests/unit/workflows/verify.test.ts
import { describe, it, expect, vi } from "vitest";
import type { StepContext, StepResult } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { verify } from "../../../src/workflows/verify.js";

// ---------------------------------------------------------------------------
// Sync engine factory
// ---------------------------------------------------------------------------
function makeSyncEngine(verdicts: Record<string, VerdictPayload>) {
  const listeners: Record<string, (v: VerdictPayload) => void> = {};
  const engine: any = {
    registerVerdictListener: vi.fn((stepName: string, cb: (v: VerdictPayload) => void) => {
      listeners[stepName] = cb;
    }),
  };

  function attachDeliver(ctx: StepContext) {
    (ctx.team.deliver as any).mockImplementation(async (_agent: string, msg: any) => {
      const match = (msg.summary as string).match(/Execute step: (.+)/);
      const step = match?.[1];
      if (step && verdicts[step]) {
        listeners[step]?.(verdicts[step]);
      }
    });
  }

  return { engine, attachDeliver };
}

function makeCtx(): StepContext {
  return {
    run: {
      goal: "Ensure all auth flows have unit test coverage",
      artifacts: {},
      steps: [],
      budget: {},
    },
    engine: {} as any,
    team: { deliver: vi.fn() },
    observer: {} as any,
  } as unknown as StepContext;
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------
describe("verify workflow — shape", () => {
  it("has name 'verify'", () => expect(verify.name).toBe("verify"));

  it("has steps: audit, write-tests, validate, review, judge-gate", () => {
    expect(verify.steps.map((s) => s.name)).toEqual([
      "audit",
      "write-tests",
      "validate",
      "review",
      "judge-gate",
    ]);
  });

  it("has correct defaults", () => {
    expect(verify.defaults).toMatchObject({
      maxIterations: 5,
      maxCostUsd: 20,
      maxWallSeconds: 3600,
    });
  });

  it("transitions: audit PASS → write-tests", () => {
    const t = verify.transitions.find(
      (x) => x.from === "audit" && x.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("write-tests");
  });

  it("transitions: audit FAIL → halt (no gaps = done)", () => {
    const t = verify.transitions.find(
      (x) => x.from === "audit" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("transitions: validate FAIL → write-tests (loop back)", () => {
    const t = verify.transitions.find(
      (x) => x.from === "validate" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("write-tests");
  });

  it("transitions: review FAIL → write-tests (revision loop)", () => {
    const t = verify.transitions.find(
      (x) => x.from === "review" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("write-tests");
  });

  it("transitions: judge-gate FAIL → write-tests (further iteration)", () => {
    const t = verify.transitions.find(
      (x) => x.from === "judge-gate" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("write-tests");
  });
});

// ---------------------------------------------------------------------------
// audit step
// ---------------------------------------------------------------------------
describe("verify — audit step", () => {
  it("PASS (gaps found): returns success=true, delivers to tester", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      audit: { verdict: "PASS", artifacts: ["coverage-gaps.md"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "audit")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "tester",
      expect.objectContaining({ summary: "Execute step: audit" }),
    );
  });

  it("FAIL (no gaps): returns success=false, halts cleanly", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      audit: { verdict: "FAIL", issues: ["Coverage is already at 95% — no gaps found"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "audit")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    // The transition engine treats this as halt — nothing to do
    const transition = verify.transitions.find(
      (t) => t.from === "audit" && t.when(result),
    );
    expect(transition?.to).toBe("halt");
  });
});

// ---------------------------------------------------------------------------
// write-tests step
// ---------------------------------------------------------------------------
describe("verify — write-tests step", () => {
  it("PASS: returns success=true, delivers to tester", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "write-tests": { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "write-tests")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "tester",
      expect.objectContaining({ summary: "Execute step: write-tests" }),
    );
  });

  it("FAIL: returns success=false", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "write-tests": { verdict: "FAIL", issues: ["Cannot mock external SDK — types unclear"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "write-tests")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validate step
// ---------------------------------------------------------------------------
describe("verify — validate step", () => {
  it("PASS: returns success=true, delivers to tester", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      validate: { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "validate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
  });

  it("FAIL: carries handoffHint for next iteration", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      validate: {
        verdict: "FAIL",
        issues: ["auth.test.ts line 42: expected 401 received 200"],
        handoffHint: "auth.test.ts:42 — mock not returning error response",
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "validate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    expect(result.handoffHint).toContain("auth.test.ts:42");
  });
});

// ---------------------------------------------------------------------------
// review step
// ---------------------------------------------------------------------------
describe("verify — review step", () => {
  it("PASS: returns success=true, delivers to reviewer", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      review: { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "review")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "reviewer",
      expect.objectContaining({ summary: "Execute step: review" }),
    );
  });
});

// ---------------------------------------------------------------------------
// judge-gate step
// ---------------------------------------------------------------------------
describe("verify — judge-gate step", () => {
  it("PASS: returns success=true, delivers to judge", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "judge-gate": { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "judge",
      expect.objectContaining({ summary: "Execute step: judge-gate" }),
    );
  });

  it("FAIL: loops back to write-tests via transition", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "judge-gate": { verdict: "FAIL", issues: ["Error paths still untested"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = verify.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await step.run(ctx);

    const transition = verify.transitions.find(
      (t) => t.from === "judge-gate" && t.when(result),
    );
    expect(transition?.to).toBe("write-tests");
  });
});
```

---

#### Steps

1. Write `tests/unit/workflows/verify.test.ts`.
2. Run `pnpm test tests/unit/workflows/verify.test.ts` — all tests fail.
3. Write `src/workflows/verify.ts`.
4. Run `pnpm test tests/unit/workflows/verify.test.ts` — all tests pass.
5. Commit:

```bash
git add src/workflows/verify.ts tests/unit/workflows/verify.test.ts
git commit -m "feat(workflows): add verify workflow (audit → write-tests → validate → review → judge-gate)"
```

---

### Task 16: debug workflow

**Files:**

- `src/workflows/debug.ts`
- `tests/unit/workflows/debug.test.ts`

---

#### Implementation

```typescript
// src/workflows/debug.ts
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`,
        ),
      );
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
      clearTimeout(timeout);
      resolve(v);
    });

    ctx.team
      .deliver(agentName, {
        id: crypto.randomUUID(),
        from: "system",
        to: agentName,
        summary: `Execute step: ${stepName}`,
        message: prompt,
        ts: new Date().toISOString(),
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Step 1 — gather-context
// Two agents collaborate: knowledge-retriever fetches code, then
// observability-archivist fetches traces. We deliver to knowledge-retriever
// first and wait for its verdict, then deliver to observability-archivist.
// Both verdicts must PASS for this step to succeed.
// ---------------------------------------------------------------------------
const gatherContextStep: Step = {
  name: "gather-context",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    // Sub-step A: code context
    const codePrompt = `You are the knowledge-retriever. Gather code context for debugging.

GOAL: ${ctx.run.goal}

Your task:
1. Identify the code paths likely involved in this bug (entrypoints, handlers, utilities).
2. Retrieve the relevant source files, recent git blame for those files, and any related ADRs.
3. Note any recent commits (last 7 days) that touched these paths.
4. Save context-code.md as an artifact.

Call VerdictEmit with:
- step: "gather-context-code"
- verdict: "PASS" if code context is assembled
- verdict: "FAIL" with issues if you could not locate the relevant code
- artifacts: ["context-code.md"]`;

    try {
      const codeVerdict = await waitForAgentVerdict(
        ctx,
        "knowledge-retriever",
        codePrompt,
        "gather-context-code",
      );

      if (codeVerdict.verdict !== "PASS") {
        return {
          success: false,
          verdict: "FAIL",
          issues: codeVerdict.issues ?? ["knowledge-retriever failed to gather code context"],
        };
      }

      // Sub-step B: observability traces
      const tracePrompt = `You are the observability-archivist. Pull recent event traces for debugging.

GOAL: ${ctx.run.goal}
CODE CONTEXT: ${codeVerdict.artifacts?.[0] ?? "context-code.md"}

Your task:
1. Query the observability system for recent traces, spans, and error events related to the goal.
2. Identify the exact span where the error occurs or latency spikes.
3. Correlate trace IDs with the code paths identified in the code context.
4. Save context-traces.md as an artifact.

Call VerdictEmit with:
- step: "gather-context-traces"
- verdict: "PASS" if relevant traces found
- verdict: "FAIL" with issues if traces are unavailable or unintelligible
- artifacts: ["context-traces.md"]`;

      const traceVerdict = await waitForAgentVerdict(
        ctx,
        "observability-archivist",
        tracePrompt,
        "gather-context-traces",
      );

      const allArtifacts: Record<string, string> = {};
      if (codeVerdict.artifacts) {
        codeVerdict.artifacts.forEach((a, i) => { allArtifacts[`code-artifact-${i}`] = a; });
      }
      if (traceVerdict.artifacts) {
        traceVerdict.artifacts.forEach((a, i) => { allArtifacts[`trace-artifact-${i}`] = a; });
      }

      return {
        success: traceVerdict.verdict === "PASS",
        verdict: traceVerdict.verdict,
        issues: traceVerdict.issues,
        artifacts: allArtifacts,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 2 — analyze
// ---------------------------------------------------------------------------
const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const codeArtifact = ctx.run.artifacts?.["code-artifact-0"] ?? "context-code.md";
    const traceArtifact = ctx.run.artifacts?.["trace-artifact-0"] ?? "context-traces.md";
    const previousFix = (ctx.run as any).previousFixIssues
      ? `\n\nPREVIOUS FIX ATTEMPT FAILED — JUDGE FEEDBACK:\n${(ctx.run as any).previousFixIssues}`
      : "";

    const prompt = `You are the root-cause-debugger. Perform deep analysis.

GOAL: ${ctx.run.goal}
CODE CONTEXT: ${codeArtifact}
TRACE CONTEXT: ${traceArtifact}${previousFix}

Your task:
1. Walk the code path from the entry point to where the failure occurs.
2. Correlate the failure with specific commits, config values, or dependency versions.
3. Produce a ranked hypothesis list (at least 3 if possible), each with:
   - Likelihood (high / medium / low)
   - Supporting evidence
   - Specific line(s) of code or config implicated
4. Identify the root cause (most likely hypothesis).
5. Save root-cause-analysis.md as an artifact.

Call VerdictEmit with:
- step: "analyze"
- verdict: "PASS" if root cause is identified with supporting evidence
- verdict: "FAIL" with issues if analysis is inconclusive (need more context)
- artifacts: ["root-cause-analysis.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "root-cause-debugger", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`rca-artifact-${i}`, a]))
          : {},
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 3 — propose-fix
// ---------------------------------------------------------------------------
const proposeFixStep: Step = {
  name: "propose-fix",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const rcaArtifact = ctx.run.artifacts?.["rca-artifact-0"] ?? "root-cause-analysis.md";

    const prompt = `You are the implementer. Propose concrete fix options.

GOAL: ${ctx.run.goal}
ROOT CAUSE ANALYSIS: ${rcaArtifact}

Your task:
Propose 2–3 concrete fix options. For each option:
1. Describe the change (which files, which lines, what change)
2. Explain the trade-offs (risk, scope, performance impact, test coverage needed)
3. Estimate complexity: trivial | small | medium | large
4. Note any follow-up work required (migration, docs update, etc.)

Save fix-options.md as an artifact. Do NOT implement yet — just propose.

Call VerdictEmit with:
- step: "propose-fix"
- verdict: "PASS" if you have produced clear, actionable fix options
- verdict: "FAIL" with issues if you cannot determine a viable fix from the RCA
- artifacts: ["fix-options.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "propose-fix");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`fix-artifact-${i}`, a]))
          : {},
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 4 — judge-gate
// ---------------------------------------------------------------------------
const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const rcaArtifact = ctx.run.artifacts?.["rca-artifact-0"] ?? "root-cause-analysis.md";
    const fixArtifact = ctx.run.artifacts?.["fix-artifact-0"] ?? "fix-options.md";

    const prompt = `You are the judge. Select the preferred fix option and approve it.

GOAL: ${ctx.run.goal}
ROOT CAUSE ANALYSIS: ${rcaArtifact}
FIX OPTIONS: ${fixArtifact}

Your task:
1. Evaluate each fix option against the root cause.
2. Select the option with the best risk/reward ratio for this context.
3. Explain why you selected it over the alternatives.
4. Specify any preconditions that must be met before implementing.

Call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" if you've selected a fix option and it's ready for implementation
- verdict: "FAIL" with issues if none of the options are acceptable
  (e.g. "All options too risky without more context — re-analyze with focus on DB transactions")
- handoffHint: the selected fix option description (for the caller to chain to plan-build-review)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------
export const debug: Workflow = {
  name: "debug",
  description:
    "Gather code + trace context, root-cause analyze, propose fix options, and get judge selection before implementation.",
  steps: [gatherContextStep, analyzeStep, proposeFixStep, judgeGateStep],
  transitions: [
    { from: "gather-context", when: (r) => r.verdict === "PASS", to: "analyze" },
    { from: "gather-context", when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "analyze",        when: (r) => r.verdict === "PASS", to: "propose-fix" },
    { from: "analyze",        when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "propose-fix",    when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "propose-fix",    when: (r) => r.verdict !== "PASS", to: "analyze" },
    { from: "judge-gate",     when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate",     when: (r) => r.verdict !== "PASS", to: "analyze" },
  ],
  defaults: {
    maxIterations: 3,
    maxCostUsd: 20,
    maxWallSeconds: 3600,
  },
};
```

---

#### Tests

```typescript
// tests/unit/workflows/debug.test.ts
import { describe, it, expect, vi } from "vitest";
import type { StepContext, StepResult } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { debug } from "../../../src/workflows/debug.js";

// ---------------------------------------------------------------------------
// Sync engine factory — supports multiple listeners with same-step-name calls
// ---------------------------------------------------------------------------
function makeSyncEngine(verdicts: Record<string, VerdictPayload>) {
  const listeners: Record<string, (v: VerdictPayload) => void> = {};
  const engine: any = {
    registerVerdictListener: vi.fn((stepName: string, cb: (v: VerdictPayload) => void) => {
      listeners[stepName] = cb;
    }),
  };

  function attachDeliver(ctx: StepContext) {
    (ctx.team.deliver as any).mockImplementation(async (_agent: string, msg: any) => {
      const match = (msg.summary as string).match(/Execute step: (.+)/);
      const step = match?.[1];
      if (step && verdicts[step]) {
        listeners[step]?.(verdicts[step]);
      }
    });
  }

  return { engine, attachDeliver };
}

function makeCtx(): StepContext {
  return {
    run: {
      goal: "API returns 500 on POST /orders — suspected null dereference in discount calculation",
      artifacts: {},
      steps: [],
      budget: {},
    },
    engine: {} as any,
    team: { deliver: vi.fn() },
    observer: {} as any,
  } as unknown as StepContext;
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------
describe("debug workflow — shape", () => {
  it("has name 'debug'", () => expect(debug.name).toBe("debug"));

  it("has steps: gather-context, analyze, propose-fix, judge-gate", () => {
    expect(debug.steps.map((s) => s.name)).toEqual([
      "gather-context",
      "analyze",
      "propose-fix",
      "judge-gate",
    ]);
  });

  it("has correct defaults", () => {
    expect(debug.defaults).toMatchObject({
      maxIterations: 3,
      maxCostUsd: 20,
      maxWallSeconds: 3600,
    });
  });

  it("transitions: gather-context PASS → analyze", () => {
    const t = debug.transitions.find(
      (x) => x.from === "gather-context" && x.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("analyze");
  });

  it("transitions: gather-context FAIL → halt", () => {
    const t = debug.transitions.find(
      (x) => x.from === "gather-context" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("transitions: propose-fix FAIL → analyze (re-analyze)", () => {
    const t = debug.transitions.find(
      (x) => x.from === "propose-fix" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("analyze");
  });

  it("transitions: judge-gate FAIL → analyze (deeper investigation)", () => {
    const t = debug.transitions.find(
      (x) => x.from === "judge-gate" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("analyze");
  });

  it("transitions: judge-gate PASS → halt", () => {
    const t = debug.transitions.find(
      (x) => x.from === "judge-gate" && x.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });
});

// ---------------------------------------------------------------------------
// gather-context step
// ---------------------------------------------------------------------------
describe("debug — gather-context step", () => {
  it("PASS path: delivers to both knowledge-retriever and observability-archivist", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "gather-context-code": { verdict: "PASS", artifacts: ["context-code.md"] },
      "gather-context-traces": { verdict: "PASS", artifacts: ["context-traces.md"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = debug.steps.find((s) => s.name === "gather-context")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "knowledge-retriever",
      expect.objectContaining({ summary: "Execute step: gather-context-code" }),
    );
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "observability-archivist",
      expect.objectContaining({ summary: "Execute step: gather-context-traces" }),
    );
  });

  it("FAIL path: returns success=false when knowledge-retriever fails", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "gather-context-code": {
        verdict: "FAIL",
        issues: ["Could not locate relevant source files"],
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = debug.steps.find((s) => s.name === "gather-context")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    expect(result.verdict).toBe("FAIL");
    // observability-archivist should NOT have been called
    const deliverCalls = (ctx.team.deliver as any).mock.calls;
    const archivist = deliverCalls.find(
      (c: any[]) => c[0] === "observability-archivist",
    );
    expect(archivist).toBeUndefined();
  });

  it("FAIL path: returns success=false when observability-archivist fails", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "gather-context-code": { verdict: "PASS", artifacts: ["context-code.md"] },
      "gather-context-traces": {
        verdict: "FAIL",
        issues: ["Observability system unavailable"],
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = debug.steps.find((s) => s.name === "gather-context")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    expect(result.issues).toContain("Observability system unavailable");
  });
});

// ---------------------------------------------------------------------------
// analyze step
// ---------------------------------------------------------------------------
describe("debug — analyze step", () => {
  it("PASS: returns success=true, delivers to root-cause-debugger", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      analyze: { verdict: "PASS", artifacts: ["root-cause-analysis.md"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = debug.steps.find((s) => s.name === "analyze")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "root-cause-debugger",
      expect.objectContaining({ summary: "Execute step: analyze" }),
    );
  });

  it("FAIL: returns success=false with issues", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      analyze: { verdict: "FAIL", issues: ["Insufficient trace data for correlation"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = debug.steps.find((s) => s.name === "analyze")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    expect(result.issues).toContain("Insufficient trace data for correlation");
  });
});

// ---------------------------------------------------------------------------
// propose-fix step
// ---------------------------------------------------------------------------
describe("debug — propose-fix step", () => {
  it("PASS: returns success=true, delivers to implementer", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "propose-fix": { verdict: "PASS", artifacts: ["fix-options.md"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = debug.steps.find((s) => s.name === "propose-fix")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "implementer",
      expect.objectContaining({ summary: "Execute step: propose-fix" }),
    );
  });
});

// ---------------------------------------------------------------------------
// judge-gate step
// ---------------------------------------------------------------------------
describe("debug — judge-gate step", () => {
  it("PASS: returns success=true with handoffHint describing selected fix", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "judge-gate": {
        verdict: "PASS",
        handoffHint: "Option 2: add null guard in calculateDiscount() at discount.ts:47",
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = debug.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(result.handoffHint).toContain("calculateDiscount");
  });

  it("FAIL: returns success=false, transition loops to analyze", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "judge-gate": {
        verdict: "FAIL",
        issues: ["Options too risky — need DB transaction analysis first"],
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = debug.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    const transition = debug.transitions.find(
      (t) => t.from === "judge-gate" && t.when(result),
    );
    expect(transition?.to).toBe("analyze");
  });
});
```

---

#### Steps

1. Write `tests/unit/workflows/debug.test.ts`.
2. Run `pnpm test tests/unit/workflows/debug.test.ts` — all tests fail.
3. Write `src/workflows/debug.ts`.
4. Run `pnpm test tests/unit/workflows/debug.test.ts` — all tests pass.
5. Commit:

```bash
git add src/workflows/debug.ts tests/unit/workflows/debug.test.ts
git commit -m "feat(workflows): add debug workflow (gather-context → analyze → propose-fix → judge-gate)"
```

---

### Task 17: fix-loop workflow

**Files:**

- `src/workflows/fix-loop.ts`
- `tests/unit/workflows/fix-loop.test.ts`

---

#### Implementation

```typescript
// src/workflows/fix-loop.ts
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`,
        ),
      );
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
      clearTimeout(timeout);
      resolve(v);
    });

    ctx.team
      .deliver(agentName, {
        id: crypto.randomUUID(),
        from: "system",
        to: agentName,
        summary: `Execute step: ${stepName}`,
        message: prompt,
        ts: new Date().toISOString(),
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Step 1 — analyze
// Uses root-cause-debugger for bugs, but can be re-used with goal context
// that describes a feature. Planner context is injected via the goal text.
// ---------------------------------------------------------------------------
const analyzeStep: Step = {
  name: "analyze",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const judgeLoopFeedback = (ctx.run as any).judgeLoopIssues
      ? `\n\nJUDGE LOOP FEEDBACK (previous cycle rejected):\n${(ctx.run as any).judgeLoopIssues}`
      : "";

    const prompt = `You are the root-cause-debugger (or planner for non-bug goals). Analyze the failing state.

GOAL: ${ctx.run.goal}${judgeLoopFeedback}

Your task:
1. If this is a bug: identify the root cause — the specific code path, line, or config responsible.
2. If this is a failing feature: identify what is missing or wrong in the implementation.
3. Produce a concrete, step-by-step fix plan that the implementer can follow precisely.
4. Flag any risks: are there side effects? Does this touch shared state or public API contracts?
5. Save fix-plan.md as an artifact.

Call VerdictEmit with:
- step: "analyze"
- verdict: "PASS" if you have a clear, actionable fix plan
- verdict: "FAIL" with issues if you cannot determine what to do (workflow will halt)
- artifacts: ["fix-plan.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "root-cause-debugger", prompt, "analyze");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`plan-artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 2 — implement
// ---------------------------------------------------------------------------
const implementStep: Step = {
  name: "implement",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const planArtifact = ctx.run.artifacts?.["plan-artifact-0"] ?? "fix-plan.md";
    const testFailureHint = (ctx.run as any).testFailureHint
      ? `\n\nFAILING TESTS FROM PREVIOUS ITERATION:\n${(ctx.run as any).testFailureHint}`
      : "";
    const reviewerIssues = (ctx.run as any).reviewerIssues
      ? `\n\nREVIEWER ISSUES TO ADDRESS:\n${(ctx.run as any).reviewerIssues}`
      : "";

    const prompt = `You are the implementer. Apply the fix according to the plan.

GOAL: ${ctx.run.goal}
FIX PLAN: ${planArtifact}${testFailureHint}${reviewerIssues}

Your task:
1. Read the fix plan carefully.
2. Apply the changes — modify the minimum number of files required to fix the issue.
3. Do NOT refactor unrelated code; keep the diff focused.
4. For any destructive operation (git push, file delete, schema migration), call RequestApproval first.
5. After applying the fix, run a quick smoke test (compilation check, lint) before emitting verdict.

Call VerdictEmit with:
- step: "implement"
- verdict: "PASS" if the fix is applied and the code compiles
- verdict: "FAIL" with issues if you were blocked or the approach in the plan is unworkable
  (the workflow will re-plan from analyze)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "implement");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 3 — test
// ---------------------------------------------------------------------------
const testStep: Step = {
  name: "test",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the tester. Run the full test suite against the current implementation.

GOAL: ${ctx.run.goal}

Your task:
1. Run the full test suite (unit + integration).
2. Capture the output — both passing and failing tests.
3. If any tests fail, save the failure output as test-failures.md.
4. Report the final pass/fail count and coverage delta.

Call VerdictEmit with:
- step: "test"
- verdict: "PASS" if ALL tests pass (zero failures, zero errors)
- verdict: "FAIL" with the list of failing tests in issues
- handoffHint: the complete test failure output (this becomes the implementer's context for the next fix attempt)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "test");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 4 — review
// ---------------------------------------------------------------------------
const reviewStep: Step = {
  name: "review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the reviewer. Inspect the fix for correctness and regressions.

GOAL: ${ctx.run.goal}
Previous steps: ${ctx.run.steps?.map((s: any) => s.name).join(", ") ?? "none"}

Your task:
1. Read the git diff of all changed files.
2. Verify the fix actually addresses the root cause (not just masking symptoms).
3. Check for regressions: does the fix break any existing behavior?
4. Check for new security or performance issues introduced by the fix.
5. Verify error handling and edge cases are covered.

Call VerdictEmit with:
- step: "review"
- verdict: "PASS" if the fix is correct, complete, and introduces no regressions
- verdict: "FAIL" with a specific list of issues (what is wrong and where)
- handoffHint: the issues as structured feedback for the implementer's next attempt`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "reviewer", prompt, "review");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Step 5 — judge-gate
// ---------------------------------------------------------------------------
const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the judge. Approve the fix for shipping.

GOAL: ${ctx.run.goal}
Previous steps: ${ctx.run.steps?.map((s: any) => s.name).join(", ") ?? "none"}

Evaluate:
1. Does the fix completely resolve the stated goal?
2. Are all tests passing?
3. Has the reviewer approved?
4. Is the solution production-safe (no hidden risk, no deferred problems)?
5. Is the change appropriately scoped (not over-engineered, not under-engineered)?

Call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" if the fix is approved for shipping — workflow completes
- verdict: "FAIL" with specific issues requiring a full re-plan cycle
  (this loops back to analyze — use this when the fix direction was fundamentally wrong)`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        handoffHint: verdict.handoffHint,
      };
    } catch (err) {
      return {
        success: false,
        verdict: "FAIL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------
export const fixLoop: Workflow = {
  name: "fix-loop",
  description:
    "Autonomous self-healing loop: analyze → implement → test → review → judge, repeating until approved or budget exhausted.",
  steps: [analyzeStep, implementStep, testStep, reviewStep, judgeGateStep],
  transitions: [
    { from: "analyze",    when: (r) => r.verdict === "PASS", to: "implement" },
    { from: "analyze",    when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "implement",  when: (r) => r.verdict === "PASS", to: "test" },
    { from: "implement",  when: (r) => r.verdict !== "PASS", to: "analyze" },
    { from: "test",       when: (r) => r.verdict === "PASS", to: "review" },
    { from: "test",       when: (r) => r.verdict !== "PASS", to: "implement" },
    { from: "review",     when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "review",     when: (r) => r.verdict !== "PASS", to: "implement" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS", to: "analyze" },
  ],
  defaults: {
    maxIterations: 8,
    maxCostUsd: 30,
    maxWallSeconds: 7200,
  },
};
```

---

#### Tests

```typescript
// tests/unit/workflows/fix-loop.test.ts
import { describe, it, expect, vi } from "vitest";
import type { StepContext, StepResult } from "../../../src/workflows/types.js";
import type { VerdictPayload } from "../../../src/types.js";
import { fixLoop } from "../../../src/workflows/fix-loop.js";

// ---------------------------------------------------------------------------
// Sync engine factory
// ---------------------------------------------------------------------------
function makeSyncEngine(verdicts: Record<string, VerdictPayload>) {
  const listeners: Record<string, (v: VerdictPayload) => void> = {};
  const engine: any = {
    registerVerdictListener: vi.fn((stepName: string, cb: (v: VerdictPayload) => void) => {
      listeners[stepName] = cb;
    }),
  };

  function attachDeliver(ctx: StepContext) {
    (ctx.team.deliver as any).mockImplementation(async (_agent: string, msg: any) => {
      const match = (msg.summary as string).match(/Execute step: (.+)/);
      const step = match?.[1];
      if (step && verdicts[step]) {
        listeners[step]?.(verdicts[step]);
      }
    });
  }

  return { engine, attachDeliver };
}

function makeCtx(): StepContext {
  return {
    run: {
      goal: "Fix null pointer exception in CartService.applyDiscount() — causes 500 on checkout",
      artifacts: {},
      steps: [],
      budget: {},
    },
    engine: {} as any,
    team: { deliver: vi.fn() },
    observer: {} as any,
  } as unknown as StepContext;
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------
describe("fix-loop workflow — shape", () => {
  it("has name 'fix-loop'", () => expect(fixLoop.name).toBe("fix-loop"));

  it("has steps: analyze, implement, test, review, judge-gate", () => {
    expect(fixLoop.steps.map((s) => s.name)).toEqual([
      "analyze",
      "implement",
      "test",
      "review",
      "judge-gate",
    ]);
  });

  it("has correct defaults", () => {
    expect(fixLoop.defaults).toMatchObject({
      maxIterations: 8,
      maxCostUsd: 30,
      maxWallSeconds: 7200,
    });
  });

  it("transitions: analyze PASS → implement", () => {
    const t = fixLoop.transitions.find(
      (x) => x.from === "analyze" && x.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("implement");
  });

  it("transitions: analyze FAIL → halt", () => {
    const t = fixLoop.transitions.find(
      (x) => x.from === "analyze" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("transitions: implement FAIL → analyze (re-plan)", () => {
    const t = fixLoop.transitions.find(
      (x) => x.from === "implement" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("analyze");
  });

  it("transitions: test FAIL → implement (fix tests)", () => {
    const t = fixLoop.transitions.find(
      (x) => x.from === "test" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("implement");
  });

  it("transitions: review FAIL → implement (revise fix)", () => {
    const t = fixLoop.transitions.find(
      (x) => x.from === "review" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("implement");
  });

  it("transitions: judge-gate PASS → halt", () => {
    const t = fixLoop.transitions.find(
      (x) => x.from === "judge-gate" && x.when({ success: true, verdict: "PASS" }),
    );
    expect(t?.to).toBe("halt");
  });

  it("transitions: judge-gate FAIL → analyze (full re-plan)", () => {
    const t = fixLoop.transitions.find(
      (x) => x.from === "judge-gate" && x.when({ success: false, verdict: "FAIL" }),
    );
    expect(t?.to).toBe("analyze");
  });
});

// ---------------------------------------------------------------------------
// analyze step
// ---------------------------------------------------------------------------
describe("fix-loop — analyze step", () => {
  it("PASS: returns success=true, delivers to root-cause-debugger", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      analyze: { verdict: "PASS", artifacts: ["fix-plan.md"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "analyze")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "root-cause-debugger",
      expect.objectContaining({ summary: "Execute step: analyze" }),
    );
  });

  it("FAIL: returns success=false — workflow halts (nothing to do)", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      analyze: { verdict: "FAIL", issues: ["Cannot determine root cause from available context"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "analyze")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    const transition = fixLoop.transitions.find(
      (t) => t.from === "analyze" && t.when(result),
    );
    expect(transition?.to).toBe("halt");
  });

  it("prompt includes goal", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      analyze: { verdict: "PASS", artifacts: [] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "analyze")!;
    await step.run(ctx);

    const deliverCall = (ctx.team.deliver as any).mock.calls[0];
    expect(deliverCall[1].message).toContain(ctx.run.goal);
  });
});

// ---------------------------------------------------------------------------
// implement step
// ---------------------------------------------------------------------------
describe("fix-loop — implement step", () => {
  it("PASS: returns success=true, delivers to implementer", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      implement: { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "implement")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "implementer",
      expect.objectContaining({ summary: "Execute step: implement" }),
    );
  });

  it("FAIL: returns success=false, transition loops to analyze", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      implement: { verdict: "FAIL", issues: ["Approach in plan is unworkable — no such API"] },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "implement")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    const transition = fixLoop.transitions.find(
      (t) => t.from === "implement" && t.when(result),
    );
    expect(transition?.to).toBe("analyze");
  });
});

// ---------------------------------------------------------------------------
// test step
// ---------------------------------------------------------------------------
describe("fix-loop — test step", () => {
  it("PASS: returns success=true, delivers to tester", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      test: { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "test")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "tester",
      expect.objectContaining({ summary: "Execute step: test" }),
    );
  });

  it("FAIL: carries handoffHint with test failure output for implementer", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      test: {
        verdict: "FAIL",
        issues: ["CartService.test.ts line 88 — expected undefined, received null"],
        handoffHint: "CartService.test.ts:88 — applyDiscount returns null instead of undefined",
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "test")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    expect(result.handoffHint).toContain("applyDiscount");
    // Transition sends back to implement
    const transition = fixLoop.transitions.find(
      (t) => t.from === "test" && t.when(result),
    );
    expect(transition?.to).toBe("implement");
  });
});

// ---------------------------------------------------------------------------
// review step
// ---------------------------------------------------------------------------
describe("fix-loop — review step", () => {
  it("PASS: returns success=true, delivers to reviewer", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      review: { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "review")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "reviewer",
      expect.objectContaining({ summary: "Execute step: review" }),
    );
  });

  it("FAIL: carries handoffHint with reviewer issues for implementer", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      review: {
        verdict: "FAIL",
        issues: ["Fix masks symptom — root null reference not addressed"],
        handoffHint: "Fix masks symptom — root null reference not addressed at line 92",
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "review")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    expect(result.handoffHint).toContain("line 92");
    const transition = fixLoop.transitions.find(
      (t) => t.from === "review" && t.when(result),
    );
    expect(transition?.to).toBe("implement");
  });
});

// ---------------------------------------------------------------------------
// judge-gate step
// ---------------------------------------------------------------------------
describe("fix-loop — judge-gate step", () => {
  it("PASS: returns success=true, delivers to judge", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "judge-gate": { verdict: "PASS" },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(true);
    expect(ctx.team.deliver).toHaveBeenCalledWith(
      "judge",
      expect.objectContaining({ summary: "Execute step: judge-gate" }),
    );
  });

  it("FAIL: loops back to analyze via transition (full re-plan)", async () => {
    const ctx = makeCtx();
    const { engine, attachDeliver } = makeSyncEngine({
      "judge-gate": {
        verdict: "FAIL",
        issues: ["Fix direction was wrong — symptom masked, not resolved. Start over."],
      },
    });
    ctx.engine = engine;
    attachDeliver(ctx);

    const step = fixLoop.steps.find((s) => s.name === "judge-gate")!;
    const result: StepResult = await step.run(ctx);

    expect(result.success).toBe(false);
    const transition = fixLoop.transitions.find(
      (t) => t.from === "judge-gate" && t.when(result),
    );
    expect(transition?.to).toBe("analyze");
  });
});

// ---------------------------------------------------------------------------
// Full PASS path (all steps fire in sequence via transition logic)
// ---------------------------------------------------------------------------
describe("fix-loop — full PASS path (transition verification)", () => {
  it("all transitions resolve correctly on all-PASS verdicts", () => {
    const passMocks: Record<string, StepResult> = {
      analyze:    { success: true, verdict: "PASS" },
      implement:  { success: true, verdict: "PASS" },
      test:       { success: true, verdict: "PASS" },
      review:     { success: true, verdict: "PASS" },
      "judge-gate": { success: true, verdict: "PASS" },
    };

    const expectedPath = [
      ["analyze",    "implement"],
      ["implement",  "test"],
      ["test",       "review"],
      ["review",     "judge-gate"],
      ["judge-gate", "halt"],
    ];

    for (const [from, expectedTo] of expectedPath) {
      const result = passMocks[from];
      const transition = fixLoop.transitions.find(
        (t) => t.from === from && t.when(result),
      );
      expect(transition?.to, `From ${from}: expected ${expectedTo}`).toBe(expectedTo);
    }
  });
});
```

---

#### Steps

1. Write `tests/unit/workflows/fix-loop.test.ts`.
2. Run `pnpm test tests/unit/workflows/fix-loop.test.ts` — all tests fail.
3. Write `src/workflows/fix-loop.ts`.
4. Run `pnpm test tests/unit/workflows/fix-loop.test.ts` — all tests pass.
5. Commit:

```bash
git add src/workflows/fix-loop.ts tests/unit/workflows/fix-loop.test.ts
git commit -m "feat(workflows): add fix-loop workflow (analyze → implement → test → review → judge-gate)"
```

---

## Summary Table

| Task | Workflow         | Steps                                                    | Agents                                                      | maxIter | maxCost | maxWall |
|------|------------------|----------------------------------------------------------|-------------------------------------------------------------|---------|---------|---------|
| 13   | investigate      | gather → analyze → judge-gate                            | knowledge-retriever, incident-investigator, judge           | 3       | $15     | 30 min  |
| 14   | triage           | classify → route → judge-gate                            | bug-triage, bug-triage, judge                               | 2       | $5      | 10 min  |
| 15   | verify           | audit → write-tests → validate → review → judge-gate    | tester ×4, reviewer, judge                                  | 5       | $20     | 60 min  |
| 16   | debug            | gather-context → analyze → propose-fix → judge-gate     | knowledge-retriever, observability-archivist, root-cause-debugger, implementer, judge | 3 | $20 | 60 min |
| 17   | fix-loop         | analyze → implement → test → review → judge-gate        | root-cause-debugger, implementer, tester, reviewer, judge   | 8       | $30     | 2 hr    |

## Notes for Implementers

**`gather-context` in `debug.ts` has a two-sub-step pattern.** The step delivers to `knowledge-retriever` (sub-step `gather-context-code`) and then to `observability-archivist` (sub-step `gather-context-traces`) sequentially within a single `Step.run()`. Both must emit `PASS` for the step to succeed. The `registerVerdictListener` keys are `gather-context-code` and `gather-context-traces` — not `gather-context`. This means the test engine must have verdicts keyed to those sub-step names.

**`audit FAIL` in `verify.ts` means "nothing to do" — it is not an error.** The transition to `halt` on FAIL from `audit` is the "done" path when coverage is already adequate. This is intentional and semantically meaningful — callers should treat a `verify` workflow that halts at `audit` FAIL as a success.

**`fix-loop` is the integration glue.** After `debug` emits a selected fix option via `handoffHint`, callers may instantiate `fix-loop` with that hint embedded in the goal. This makes `debug → fix-loop` the primary autonomous self-healing pipeline.

**All workflows follow the `WorkflowTransition.to` type** from `src/workflows/types.ts`, which allows the literal string `"halt"` as a valid destination alongside step names.


---

# pi-engteam Plan B — Section 3: Workflows (Tasks 18–20), Install Scripts (Task 21), Doctor Command (Task 22), Integration Tests (Tasks 23–25), Wire-up (Task 26), and Package.json Finalization (Task 27)

This document covers Tasks 18–27 of the pi-engteam Plan B implementation. It assumes the following are already in place from Plan B Sections 1–2:

- All 14 agent markdown files under `agents/`
- `src/types.ts`, `src/workflows/types.ts`
- `src/workflows/plan-build-review.ts` (reference implementation)
- `src/adw/ADWEngine.ts`, `src/adw/RunState.ts`, `src/adw/BudgetGuard.ts`
- `src/team/MessageBus.ts`, `src/team/TeamRuntime.ts`
- `src/safety/classifier.ts`, `src/safety/SafetyGuard.ts`, `src/safety/patterns.ts`, `src/safety/paths.ts`
- `src/commands/team-start.ts`, `team-stop.ts`, `run-start.ts`, `run-resume.ts`, `run-abort.ts`, `run-status.ts`
- `src/observer/Observer.ts`, `src/config.ts`
- The workflow helper `waitForAgentVerdict` pattern established in `plan-build-review.ts`

---

## Workflow helper pattern (reference)

Every workflow file re-uses this internal helper (copy verbatim, it is not exported from a shared module):

```typescript
async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
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
```

---

## Task 18: Migration Workflow

### Files

- `src/workflows/migration.ts`
- `tests/unit/workflows/migration.test.ts`

### Step 1 — Write the failing test

Create `tests/unit/workflows/migration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { migration } from "../../../src/workflows/migration.js";

describe("migration workflow shape", () => {
  it("exports a Workflow with name 'migration'", () => {
    expect(migration.name).toBe("migration");
  });

  it("has exactly 5 steps in the correct order", () => {
    const names = migration.steps.map(s => s.name);
    expect(names).toEqual(["plan", "security-review", "implement", "test", "judge-gate"]);
  });

  it("all steps are required", () => {
    expect(migration.steps.every(s => s.required)).toBe(true);
  });

  it("defaults match spec", () => {
    expect(migration.defaults.maxIterations).toBe(5);
    expect(migration.defaults.maxCostUsd).toBe(25);
    expect(migration.defaults.maxWallSeconds).toBe(3600);
  });

  it("plan PASS → security-review", () => {
    const t = migration.transitions.find(
      x => x.from === "plan" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("security-review");
  });

  it("plan FAIL → halt", () => {
    const t = migration.transitions.find(
      x => x.from === "plan" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("security-review PASS → implement", () => {
    const t = migration.transitions.find(
      x => x.from === "security-review" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("implement");
  });

  it("security-review FAIL → plan (re-plan with security feedback)", () => {
    const t = migration.transitions.find(
      x => x.from === "security-review" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("plan");
  });

  it("implement PASS → test", () => {
    const t = migration.transitions.find(
      x => x.from === "implement" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("test");
  });

  it("implement FAIL → halt", () => {
    const t = migration.transitions.find(
      x => x.from === "implement" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("test PASS → judge-gate", () => {
    const t = migration.transitions.find(
      x => x.from === "test" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("judge-gate");
  });

  it("test FAIL → implement (fix migration scripts)", () => {
    const t = migration.transitions.find(
      x => x.from === "test" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("implement");
  });

  it("judge-gate PASS → halt", () => {
    const t = migration.transitions.find(
      x => x.from === "judge-gate" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate FAIL → plan (re-plan)", () => {
    const t = migration.transitions.find(
      x => x.from === "judge-gate" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("plan");
  });
});
```

### Step 2 — Verify the test fails

```bash
pnpm test tests/unit/workflows/migration.test.ts
# Expected: Cannot find module '../../src/workflows/migration.js'
```

### Step 3 — Implement `src/workflows/migration.ts`

```typescript
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
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

const planStep: Step = {
  name: "plan",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the architect. Design a database/schema migration for the following goal:

GOAL: ${ctx.run.goal}

Please produce:
1. A description of all schema changes (tables added, columns added/removed/altered, index changes)
2. A rollback strategy: how to reverse every change if the migration fails mid-way
3. Data transformation steps: any row-level data moves, backfills, or casts required
4. Estimated downtime: whether the migration can run online or requires a maintenance window
5. Write your plan to migration-plan.md

When complete, call VerdictEmit with:
- step: "plan"
- verdict: "PASS" if a safe, reversible migration plan is possible
- verdict: "FAIL" with issues listed if the goal is not feasible or the schema is in an unknown state
- artifacts: ["migration-plan.md"]`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "architect", prompt, "plan");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? { migrationPlan: verdict.artifacts[0] ?? "migration-plan.md" }
          : { migrationPlan: "migration-plan.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const securityReviewStep: Step = {
  name: "security-review",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const migrationPlan = ctx.run.artifacts["migrationPlan"] ?? "migration-plan.md";
    const prompt = `You are the security-auditor. Review the following migration plan for security risks:

MIGRATION PLAN: ${migrationPlan}
GOAL: ${ctx.run.goal}

Check for:
1. Data exposure: does the migration move sensitive data (PII, secrets, tokens) into less-protected columns or tables?
2. Privilege escalation: does the migration grant new permissions or roles to database users?
3. Unsafe column drops: are columns being dropped that could expose orphaned references or audit trails?
4. Missing encryption: are new columns for sensitive data unencrypted?
5. Injection risks: are any migration scripts using dynamic SQL with unsanitized inputs?

When review is complete, call VerdictEmit with:
- step: "security-review"
- verdict: "PASS" if no blocking security issues are found
- verdict: "FAIL" with a specific list of issues (what is wrong and which schema object) if blocking issues exist`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "security-auditor", prompt, "security-review");
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

const implementStep: Step = {
  name: "implement",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const migrationPlan = ctx.run.artifacts["migrationPlan"] ?? "migration-plan.md";
    const prompt = `You are the implementer. Write migration scripts for the following plan:

MIGRATION PLAN: ${migrationPlan}
GOAL: ${ctx.run.goal}
PREVIOUS ISSUES: ${(ctx.run.steps.find(s => s.name === "implement")?.issues ?? []).join("; ") || "none"}

Please:
1. Write an "up" migration script (applies changes forward)
2. Write a "down" migration script (fully reverses the up migration)
3. Include transaction wrapping where the database supports it
4. Name them migration-up.sql and migration-down.sql (or .ts/.js for ORM-based migrations)
5. Add inline comments explaining each DDL statement

For any destructive operation (DROP TABLE, DROP COLUMN, TRUNCATE), call RequestApproval first.

When done, call VerdictEmit with:
- step: "implement"
- verdict: "PASS" with artifacts: ["migration-up.sql", "migration-down.sql"]
- verdict: "FAIL" with specific issues if any DDL statement cannot be safely written`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "implement");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`script-${i}`, a]))
          : {},
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const testStep: Step = {
  name: "test",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the tester. Verify the migration scripts are correct.

GOAL: ${ctx.run.goal}
ARTIFACTS: ${JSON.stringify(ctx.run.artifacts)}

Please:
1. Run the "up" migration against a test/staging database (not production)
2. Verify the schema matches the expected post-migration state
3. Run the "down" migration to confirm rollback works cleanly
4. Verify the schema is restored to its pre-migration state after rollback
5. Note any data loss, constraint violations, or lock escalation issues

When testing is complete, call VerdictEmit with:
- step: "test"
- verdict: "PASS" if both up and down migrations ran cleanly without errors or data loss
- verdict: "FAIL" with specific error messages and line numbers if any migration script failed`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "test");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the judge. Review the complete migration for production readiness.

GOAL: ${ctx.run.goal}
ALL COMPLETED STEPS: ${ctx.run.steps.map(s => `${s.name}(${s.verdict})`).join(", ")}
ARTIFACTS: ${JSON.stringify(ctx.run.artifacts)}

Review the full history of this migration run. Consider:
1. Did security review raise and resolve all concerns?
2. Did the test step confirm both up and down migrations work?
3. Is the estimated downtime acceptable for the application's SLA?
4. Is there an approved rollback procedure if production migration fails?

Call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" to approve the migration for production deployment
- verdict: "FAIL" with specific concerns if the migration is not production-ready`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const migration: Workflow = {
  name: "migration",
  description: "Design, security-review, implement, and test a database/schema migration with a judge gate before production.",
  steps: [planStep, securityReviewStep, implementStep, testStep, judgeGateStep],
  transitions: [
    { from: "plan",            when: (r) => r.verdict === "PASS", to: "security-review" },
    { from: "plan",            when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "security-review", when: (r) => r.verdict === "PASS", to: "implement" },
    { from: "security-review", when: (r) => r.verdict !== "PASS", to: "plan" },
    { from: "implement",       when: (r) => r.verdict === "PASS", to: "test" },
    { from: "implement",       when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "test",            when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "test",            when: (r) => r.verdict !== "PASS", to: "implement" },
    { from: "judge-gate",      when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate",      when: (r) => r.verdict !== "PASS", to: "plan" },
  ],
  defaults: {
    maxIterations: 5,
    maxCostUsd: 25,
    maxWallSeconds: 3600,
  },
};
```

### Step 4 — Run tests and verify pass

```bash
pnpm test tests/unit/workflows/migration.test.ts
# Expected: all 14 assertions green
```

### Step 5 — Commit

```bash
git add src/workflows/migration.ts tests/unit/workflows/migration.test.ts
git commit -m "feat: migration workflow with security-review and judge gate"
```

---

## Task 19: Refactor-Campaign Workflow

### Files

- `src/workflows/refactor-campaign.ts`
- `tests/unit/workflows/refactor-campaign.test.ts`

### Step 1 — Write the failing test

Create `tests/unit/workflows/refactor-campaign.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { refactorCampaign } from "../../../src/workflows/refactor-campaign.js";

describe("refactor-campaign workflow shape", () => {
  it("exports a Workflow with name 'refactor-campaign'", () => {
    expect(refactorCampaign.name).toBe("refactor-campaign");
  });

  it("has exactly 6 steps in the correct order", () => {
    const names = refactorCampaign.steps.map(s => s.name);
    expect(names).toEqual(["map", "design", "implement", "verify", "review", "judge-gate"]);
  });

  it("all steps are required", () => {
    expect(refactorCampaign.steps.every(s => s.required)).toBe(true);
  });

  it("defaults match spec", () => {
    expect(refactorCampaign.defaults.maxIterations).toBe(6);
    expect(refactorCampaign.defaults.maxCostUsd).toBe(40);
    expect(refactorCampaign.defaults.maxWallSeconds).toBe(7200);
  });

  it("map PASS → design", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "map" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("design");
  });

  it("map FAIL → halt", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "map" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("design PASS → implement", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "design" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("implement");
  });

  it("design FAIL → halt", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "design" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("implement PASS → verify", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "implement" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("verify");
  });

  it("implement FAIL → design (re-design with feedback)", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "implement" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("design");
  });

  it("verify PASS → review", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "verify" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("review");
  });

  it("verify FAIL → implement (fix regressions)", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "verify" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("implement");
  });

  it("review PASS → judge-gate", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "review" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("judge-gate");
  });

  it("review FAIL → implement (address reviewer issues)", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "review" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("implement");
  });

  it("judge-gate PASS → halt", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "judge-gate" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate FAIL → design (full re-design)", () => {
    const t = refactorCampaign.transitions.find(
      x => x.from === "judge-gate" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("design");
  });
});
```

### Step 2 — Verify the test fails

```bash
pnpm test tests/unit/workflows/refactor-campaign.test.ts
# Expected: Cannot find module '../../src/workflows/refactor-campaign.js'
```

### Step 3 — Implement `src/workflows/refactor-campaign.ts`

```typescript
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
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

const mapStep: Step = {
  name: "map",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the codebase-cartographer. Map the impact of the following refactor:

GOAL: ${ctx.run.goal}

Please produce a refactor-map.md that includes:
1. Every file affected by this refactor (full relative paths)
2. Dependency chains: which files import the files being changed, and transitively
3. Hotspots: files that are changed AND imported by many other files (high blast radius)
4. Test coverage gaps: affected files with no test coverage or weak coverage
5. Public API surface: any exported symbols that will change and their consumers

When mapping is complete, call VerdictEmit with:
- step: "map"
- verdict: "PASS" with artifacts: ["refactor-map.md"]
- verdict: "FAIL" with issues if the codebase state is too unknown to map safely`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "codebase-cartographer", prompt, "map");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { refactorMap: verdict.artifacts?.[0] ?? "refactor-map.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const designStep: Step = {
  name: "design",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const refactorMap = ctx.run.artifacts["refactorMap"] ?? "refactor-map.md";
    const previousIssues = ctx.run.steps.find(s => s.name === "design")?.issues ?? [];
    const prompt = `You are the architect. Design the refactor strategy.

GOAL: ${ctx.run.goal}
REFACTOR MAP: ${refactorMap}
PREVIOUS DESIGN ISSUES: ${previousIssues.join("; ") || "none"}

Produce a refactor-strategy.md that includes:
1. What changes, described file-by-file in the order they should be applied
2. Invariants to preserve: behaviours, public APIs, and test contracts that must not regress
3. The implementation order: which changes must happen before others (topological order from the map)
4. Rename sites: every location where a symbol being renamed appears
5. A checklist the implementer can tick off as each file is done

Call VerdictEmit with:
- step: "design"
- verdict: "PASS" with artifacts: ["refactor-strategy.md"]
- verdict: "FAIL" with issues if the refactor is not safely designable given the map`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "architect", prompt, "design");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { refactorStrategy: verdict.artifacts?.[0] ?? "refactor-strategy.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const implementStep: Step = {
  name: "implement",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const refactorStrategy = ctx.run.artifacts["refactorStrategy"] ?? "refactor-strategy.md";
    const previousIssues = ctx.run.steps.find(s => s.name === "implement")?.issues ?? [];
    const prompt = `You are the implementer. Execute the refactor according to the strategy.

GOAL: ${ctx.run.goal}
REFACTOR STRATEGY: ${refactorStrategy}
PREVIOUS IMPLEMENTATION ISSUES: ${previousIssues.join("; ") || "none"}

Please:
1. Read the refactor strategy
2. Apply changes file-by-file in the order specified
3. Tick off each item on the strategy checklist as you complete it
4. Do NOT change any behaviour — this is a structural refactor only
5. Update all import paths at every rename site

Call VerdictEmit with:
- step: "implement"
- verdict: "PASS" when all files are changed and TypeScript compiles without errors
- verdict: "FAIL" with specific issues (file path, error message) if any change could not be applied`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "implement");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`artifact-${i}`, a]))
          : {},
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const verifyStep: Step = {
  name: "verify",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the tester. Run the full test suite to verify the refactor introduced no regressions.

GOAL: ${ctx.run.goal}

Please:
1. Run the full test suite (pnpm test or equivalent)
2. Run the type checker (pnpm typecheck or tsc --noEmit)
3. Report any failing test with its full name and error message
4. Report any type errors with file path and line number

Call VerdictEmit with:
- step: "verify"
- verdict: "PASS" ONLY if zero test failures and zero type errors
- verdict: "FAIL" with the complete list of failing tests/errors if any failures exist`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "tester", prompt, "verify");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
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
    const refactorStrategy = ctx.run.artifacts["refactorStrategy"] ?? "refactor-strategy.md";
    const prompt = `You are the reviewer. Review the completed refactor.

GOAL: ${ctx.run.goal}
REFACTOR STRATEGY: ${refactorStrategy}

Check for:
1. Hidden coupling: new implicit dependencies introduced by the refactor
2. Missed rename sites: any location where the old symbol name still appears
3. Semantic drift: any place where the refactor accidentally changed behaviour rather than just structure
4. Dead code: any functions, classes, or modules now unreachable after the refactor
5. Strategy compliance: does the implementation match the strategy document?

Call VerdictEmit with:
- step: "review"
- verdict: "PASS" if the refactor is clean and complete
- verdict: "FAIL" with a specific list of issues (file, line, issue description) if problems exist`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "reviewer", prompt, "review");
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

const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the judge. Approve or reject the completed refactor campaign.

GOAL: ${ctx.run.goal}
ALL COMPLETED STEPS: ${ctx.run.steps.map(s => `${s.name}(${s.verdict})`).join(", ")}

Review the full history of this refactor run:
1. Did the codebase map correctly identify all affected files?
2. Did the design specify a safe, ordered approach?
3. Did verify confirm zero regressions?
4. Did the reviewer find and clear all issues?

Call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" to approve the refactored codebase for merge
- verdict: "FAIL" with specific concerns requiring a full re-design`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const refactorCampaign: Workflow = {
  name: "refactor-campaign",
  description: "Map, design, implement, verify, and review a large multi-file refactor with a judge gate.",
  steps: [mapStep, designStep, implementStep, verifyStep, reviewStep, judgeGateStep],
  transitions: [
    { from: "map",        when: (r) => r.verdict === "PASS", to: "design" },
    { from: "map",        when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "design",     when: (r) => r.verdict === "PASS", to: "implement" },
    { from: "design",     when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "implement",  when: (r) => r.verdict === "PASS", to: "verify" },
    { from: "implement",  when: (r) => r.verdict !== "PASS", to: "design" },
    { from: "verify",     when: (r) => r.verdict === "PASS", to: "review" },
    { from: "verify",     when: (r) => r.verdict !== "PASS", to: "implement" },
    { from: "review",     when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "review",     when: (r) => r.verdict !== "PASS", to: "implement" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS", to: "design" },
  ],
  defaults: {
    maxIterations: 6,
    maxCostUsd: 40,
    maxWallSeconds: 7200,
  },
};
```

### Step 4 — Run tests and verify pass

```bash
pnpm test tests/unit/workflows/refactor-campaign.test.ts
# Expected: all 16 assertions green
```

### Step 5 — Commit

```bash
git add src/workflows/refactor-campaign.ts tests/unit/workflows/refactor-campaign.test.ts
git commit -m "feat: refactor-campaign workflow with map/design/verify/review/judge-gate"
```

---

## Task 20: Doc-Backfill Workflow

### Files

- `src/workflows/doc-backfill.ts`
- `tests/unit/workflows/doc-backfill.test.ts`

### Step 1 — Write the failing test

Create `tests/unit/workflows/doc-backfill.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { docBackfill } from "../../../src/workflows/doc-backfill.js";

describe("doc-backfill workflow shape", () => {
  it("exports a Workflow with name 'doc-backfill'", () => {
    expect(docBackfill.name).toBe("doc-backfill");
  });

  it("has exactly 5 steps in the correct order", () => {
    const names = docBackfill.steps.map(s => s.name);
    expect(names).toEqual(["audit", "plan", "write", "review", "judge-gate"]);
  });

  it("all steps are required", () => {
    expect(docBackfill.steps.every(s => s.required)).toBe(true);
  });

  it("defaults match spec", () => {
    expect(docBackfill.defaults.maxIterations).toBe(4);
    expect(docBackfill.defaults.maxCostUsd).toBe(15);
    expect(docBackfill.defaults.maxWallSeconds).toBe(3600);
  });

  it("audit PASS → plan", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "audit" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("plan");
  });

  it("audit FAIL (nothing to document) → halt", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "audit" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("plan PASS → write", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "plan" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("write");
  });

  it("plan FAIL → halt", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "plan" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("write PASS → review", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "write" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("review");
  });

  it("write FAIL → halt", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "write" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("review PASS → judge-gate", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "review" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("judge-gate");
  });

  it("review FAIL → write (revise docs per feedback)", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "review" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("write");
  });

  it("judge-gate PASS → halt", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "judge-gate" && x.when({ success: true, verdict: "PASS" } as any),
    );
    expect(t?.to).toBe("halt");
  });

  it("judge-gate FAIL → write", () => {
    const t = docBackfill.transitions.find(
      x => x.from === "judge-gate" && x.when({ success: false, verdict: "FAIL" } as any),
    );
    expect(t?.to).toBe("write");
  });
});
```

### Step 2 — Verify the test fails

```bash
pnpm test tests/unit/workflows/doc-backfill.test.ts
# Expected: Cannot find module '../../src/workflows/doc-backfill.js'
```

### Step 3 — Implement `src/workflows/doc-backfill.ts`

```typescript
import type { VerdictPayload } from "../types.js";
import type { Workflow, Step, StepContext, StepResult } from "./types.js";

async function waitForAgentVerdict(
  ctx: StepContext,
  agentName: string,
  prompt: string,
  stepName: string,
): Promise<VerdictPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not emit verdict for step ${stepName} within 10 minutes`));
    }, 10 * 60 * 1000);

    (ctx.engine as any).registerVerdictListener(stepName, (v: VerdictPayload) => {
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

const auditStep: Step = {
  name: "audit",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the knowledge-retriever. Audit the codebase for documentation gaps.

GOAL: ${ctx.run.goal}

Scan the entire codebase and produce a doc-audit.md that lists:
1. Undocumented public APIs: exported functions, classes, and types with no JSDoc/TSDoc comment
2. Modules without READMEs: directories that contain source files but have no README.md
3. ADR gaps: architectural decisions that appear to have been made (major abstractions, key patterns) but have no corresponding Architecture Decision Record
4. Score each gap by priority: HIGH (user-facing API), MEDIUM (internal API used across modules), LOW (internal helpers)

Call VerdictEmit with:
- step: "audit"
- verdict: "PASS" with artifacts: ["doc-audit.md"] if documentation gaps were found
- verdict: "FAIL" with issues: ["nothing to document"] if the codebase is already fully documented`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "knowledge-retriever", prompt, "audit");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { docAudit: verdict.artifacts?.[0] ?? "doc-audit.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const planStep: Step = {
  name: "plan",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const docAudit = ctx.run.artifacts["docAudit"] ?? "doc-audit.md";
    const prompt = `You are the planner. Produce a prioritized doc backfill plan.

GOAL: ${ctx.run.goal}
DOC AUDIT: ${docAudit}

Read the audit and produce a doc-backfill-plan.md that:
1. Orders documentation tasks from highest to lowest priority
2. Groups related items (e.g., all exports from the same module together)
3. Estimates writing effort (S/M/L) for each item
4. Identifies which items can be auto-generated vs require human understanding of intent
5. Sets a completion target: which items must be done in this run vs deferred

Call VerdictEmit with:
- step: "plan"
- verdict: "PASS" with artifacts: ["doc-backfill-plan.md"]
- verdict: "FAIL" with issues if the audit is too incomplete to plan from`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "planner", prompt, "plan");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: { ...ctx.run.artifacts, docPlan: verdict.artifacts?.[0] ?? "doc-backfill-plan.md" },
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const writeStep: Step = {
  name: "write",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const docPlan = ctx.run.artifacts["docPlan"] ?? "doc-backfill-plan.md";
    const previousIssues = ctx.run.steps.find(s => s.name === "write")?.issues ?? [];
    const prompt = `You are the implementer. Write the documentation according to the backfill plan.

GOAL: ${ctx.run.goal}
DOC BACKFILL PLAN: ${docPlan}
PREVIOUS REVIEW ISSUES: ${previousIssues.join("; ") || "none"}

For each item in the plan:
1. For exported functions and types: add TSDoc comments with @param, @returns, @throws, and @example
2. For modules without READMEs: create a README.md explaining purpose, public API, and usage examples
3. For ADR gaps: create ADR files in docs/adr/ following the standard template (Status, Context, Decision, Consequences)

Documentation must accurately reflect the actual implementation — do NOT invent behaviour.

Call VerdictEmit with:
- step: "write"
- verdict: "PASS" when all plan items are addressed
- verdict: "FAIL" with specific issues if any item could not be documented without more context`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "implementer", prompt, "write");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
        artifacts: verdict.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`doc-${i}`, a]))
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
    const prompt = `You are the reviewer. Verify the documentation accuracy.

GOAL: ${ctx.run.goal}
COMPLETED STEPS: ${ctx.run.steps.map(s => s.name).join(", ")}

For each piece of documentation written:
1. Read the corresponding source code
2. Verify the JSDoc/TSDoc parameter descriptions match actual parameter names and types
3. Verify @returns descriptions match actual return types
4. Verify any @example code actually compiles and produces the described output
5. Verify README files correctly describe the module's actual exports and behaviour
6. Verify ADRs reference real constraints and correctly describe the decision made

Call VerdictEmit with:
- step: "review"
- verdict: "PASS" if all documentation accurately reflects the implementation
- verdict: "FAIL" with a list of inaccuracies (file, section, what is wrong) if any doc is misleading`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "reviewer", prompt, "review");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const judgeGateStep: Step = {
  name: "judge-gate",
  required: true,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const prompt = `You are the judge. Approve or reject the documentation backfill.

GOAL: ${ctx.run.goal}
ALL COMPLETED STEPS: ${ctx.run.steps.map(s => `${s.name}(${s.verdict})`).join(", ")}

Evaluate:
1. Does the documentation cover all HIGH-priority items from the audit?
2. Is the documentation accurate — does it match actual implementations?
3. Are ADRs present for the major architectural decisions identified in the audit?
4. Is the documentation complete enough that a new engineer could onboard from it?

Call VerdictEmit with:
- step: "judge-gate"
- verdict: "PASS" to approve the documentation as accurate and sufficiently complete
- verdict: "FAIL" with specific gaps or inaccuracies that must be corrected before approval`;

    try {
      const verdict = await waitForAgentVerdict(ctx, "judge", prompt, "judge-gate");
      return {
        success: verdict.verdict === "PASS",
        verdict: verdict.verdict,
        issues: verdict.issues,
      };
    } catch (err) {
      return { success: false, verdict: "FAIL", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const docBackfill: Workflow = {
  name: "doc-backfill",
  description: "Audit, plan, write, and review documentation for undocumented code with a judge gate.",
  steps: [auditStep, planStep, writeStep, reviewStep, judgeGateStep],
  transitions: [
    { from: "audit",      when: (r) => r.verdict === "PASS", to: "plan" },
    { from: "audit",      when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "plan",       when: (r) => r.verdict === "PASS", to: "write" },
    { from: "plan",       when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "write",      when: (r) => r.verdict === "PASS", to: "review" },
    { from: "write",      when: (r) => r.verdict !== "PASS", to: "halt" },
    { from: "review",     when: (r) => r.verdict === "PASS", to: "judge-gate" },
    { from: "review",     when: (r) => r.verdict !== "PASS", to: "write" },
    { from: "judge-gate", when: (r) => r.verdict === "PASS", to: "halt" },
    { from: "judge-gate", when: (r) => r.verdict !== "PASS", to: "write" },
  ],
  defaults: {
    maxIterations: 4,
    maxCostUsd: 15,
    maxWallSeconds: 3600,
  },
};
```

### Step 4 — Run tests and verify pass

```bash
pnpm test tests/unit/workflows/doc-backfill.test.ts
# Expected: all 14 assertions green
```

### Step 5 — Commit

```bash
git add src/workflows/doc-backfill.ts tests/unit/workflows/doc-backfill.test.ts
git commit -m "feat: doc-backfill workflow with audit/plan/write/review/judge-gate"
```

---

## Task 21: Install and Uninstall Shell Scripts

### Files

- `scripts/install.sh`
- `scripts/uninstall.sh`
- `package.json` (script additions)

### Note on testing

Shell install scripts do filesystem operations that depend on a real Pi installation layout. There is no unit test for Task 21. The scripts are verified by running them manually in a Pi-installed environment. The commit message reflects this.

### Step 1 — Verify `scripts/` directory exists (or create it)

```bash
ls /Users/ndcollins/Clients/Sartoris/Projects/pi-engteam/
# If 'scripts' is absent:
mkdir -p /Users/ndcollins/Clients/Sartoris/Projects/pi-engteam/scripts
```

### Step 2 — Create `scripts/install.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${HOME}/.pi/agent/extensions"
AGENTS_DIR="${HOME}/.pi/agent/agents"
ENGTEAM_DIR="${HOME}/.pi/engteam"
DIST_FILE="$(dirname "$0")/../dist/index.js"

if [ ! -f "$DIST_FILE" ]; then
  echo "ERROR: dist/index.js not found. Run 'pnpm build' first." >&2
  exit 1
fi

mkdir -p "$EXTENSION_DIR" "$AGENTS_DIR" "$ENGTEAM_DIR/runs"

cp "$DIST_FILE" "$EXTENSION_DIR/pi-engteam.js"
echo "Installed extension: $EXTENSION_DIR/pi-engteam.js"

# Install agent markdown files
for md in "$(dirname "$0")/../agents/"*.md; do
  cp "$md" "$AGENTS_DIR/engteam-$(basename "$md")"
  echo "Installed agent: $AGENTS_DIR/engteam-$(basename "$md")"
done

echo ""
echo "pi-engteam installed. Restart Pi and run /team-start to boot the team."
```

After writing, make it executable:

```bash
chmod +x scripts/install.sh
```

### Step 3 — Create `scripts/uninstall.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${HOME}/.pi/agent/extensions"
AGENTS_DIR="${HOME}/.pi/agent/agents"

rm -f "$EXTENSION_DIR/pi-engteam.js"
echo "Removed $EXTENSION_DIR/pi-engteam.js"

for f in "$AGENTS_DIR/engteam-"*.md; do
  [ -f "$f" ] && rm "$f" && echo "Removed $f"
done

echo "pi-engteam uninstalled."
```

After writing, make it executable:

```bash
chmod +x scripts/uninstall.sh
```

### Step 4 — Update `package.json` scripts

Add to the `"scripts"` object in `package.json`:

```json
"install:extension": "bash scripts/install.sh",
"uninstall:extension": "bash scripts/uninstall.sh",
"engteam:install": "pnpm build && bash scripts/install.sh"
```

The final `scripts` block should read:

```json
"scripts": {
  "build": "tsup",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit",
  "install:extension": "bash scripts/install.sh",
  "uninstall:extension": "bash scripts/uninstall.sh",
  "engteam:install": "pnpm build && bash scripts/install.sh"
}
```

### Step 5 — Commit

```bash
git add scripts/install.sh scripts/uninstall.sh package.json
git commit -m "feat: install and uninstall shell scripts"
```

---

## Task 22: Doctor Command

### Files

- `src/commands/doctor.ts`
- `tests/unit/commands/doctor.test.ts`
- `src/index.ts` (updated to wire the command)

### Step 1 — Write the failing test

Create `tests/unit/commands/doctor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock fs/promises BEFORE importing the module under test so the
// mock is in place when the module resolves its imports.
vi.mock("fs/promises", () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import { stat, readFile } from "fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Dynamically re-import after mock is set up
async function loadDoctor() {
  const mod = await import("../../../src/commands/doctor.js");
  return mod.registerDoctorCommand;
}

function buildMockPi(): { registerCommand: ReturnType<typeof vi.fn>; lastHandler: any } {
  let lastHandler: any;
  const registerCommand = vi.fn((_name: string, opts: any) => {
    lastHandler = opts.handler;
  });
  return {
    registerCommand,
    get lastHandler() { return lastHandler; },
  };
}

describe("registerDoctorCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("registers a command named 'engteam-doctor'", async () => {
    const registerDoctorCommand = await loadDoctor();
    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);
    expect(mock.registerCommand).toHaveBeenCalledOnce();
    expect(mock.registerCommand.mock.calls[0][0]).toBe("engteam-doctor");
  });

  it("reports all checks passed when all files exist and safety.json is valid JSON", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockResolvedValue({} as any);
    vi.mocked(readFile).mockResolvedValue('{"hardBlockers":{"enabled":true,"alwaysOn":true}}');

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const result = await mock.lastHandler({}, {});
    expect(result.message).toContain("All checks passed.");
    expect(result.message).not.toContain("✗");
  });

  it("reports failures when extension file is missing", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const result = await mock.lastHandler({}, {});
    expect(result.message).toContain("✗");
    expect(result.message).toContain("issues");
    expect(result.message).toContain("pnpm install:extension");
  });

  it("includes all 14 agent checks", async () => {
    const registerDoctorCommand = await loadDoctor();
    vi.mocked(stat).mockResolvedValue({} as any);
    vi.mocked(readFile).mockResolvedValue("{}");

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const result = await mock.lastHandler({}, {});
    const agentNames = [
      "planner", "implementer", "reviewer", "architect", "codebase-cartographer",
      "tester", "security-auditor", "performance-analyst", "bug-triage", "incident-investigator",
      "root-cause-debugger", "judge", "knowledge-retriever", "observability-archivist",
    ];
    for (const name of agentNames) {
      expect(result.message).toContain(`Agent: ${name}`);
    }
  });

  it("reports safety.json issue but does not fail hard when safety.json is absent", async () => {
    const registerDoctorCommand = await loadDoctor();
    // stat succeeds for everything except safety.json is handled by readFile
    vi.mocked(stat).mockResolvedValue({} as any);
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    const mock = buildMockPi();
    registerDoctorCommand(mock as unknown as ExtensionAPI);

    const result = await mock.lastHandler({}, {});
    expect(result.message).toContain("safety.json");
    expect(result.message).toContain("Missing or invalid");
  });
});
```

### Step 2 — Verify the test fails

```bash
pnpm test tests/unit/commands/doctor.test.ts
# Expected: Cannot find module '../../src/commands/doctor.js'
```

### Step 3 — Implement `src/commands/doctor.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stat, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

type CheckResult = { name: string; ok: boolean; message: string };

async function checkExists(path: string, label: string): Promise<CheckResult> {
  try {
    await stat(path);
    return { name: label, ok: true, message: `Found: ${path}` };
  } catch {
    return { name: label, ok: false, message: `Missing: ${path}` };
  }
}

export function registerDoctorCommand(pi: ExtensionAPI): void {
  pi.registerCommand("engteam-doctor", {
    description: "Check pi-engteam installation health",
    handler: async (_args: string, _ctx) => {
      const home = homedir();
      const checks: CheckResult[] = [];

      checks.push(
        await checkExists(
          join(home, ".pi", "agent", "extensions", "pi-engteam.js"),
          "Extension file",
        ),
      );
      checks.push(
        await checkExists(
          join(home, ".pi", "engteam", "runs"),
          "Runs directory",
        ),
      );

      const agentNames = [
        "planner",
        "implementer",
        "reviewer",
        "architect",
        "codebase-cartographer",
        "tester",
        "security-auditor",
        "performance-analyst",
        "bug-triage",
        "incident-investigator",
        "root-cause-debugger",
        "judge",
        "knowledge-retriever",
        "observability-archivist",
      ];

      for (const name of agentNames) {
        checks.push(
          await checkExists(
            join(home, ".pi", "agent", "agents", `engteam-${name}.md`),
            `Agent: ${name}`,
          ),
        );
      }

      const safetyPath = join(home, ".pi", "engteam", "safety.json");
      try {
        const raw = await readFile(safetyPath, "utf8");
        JSON.parse(raw);
        checks.push({ name: "safety.json", ok: true, message: "Valid JSON" });
      } catch {
        checks.push({
          name: "safety.json",
          ok: false,
          message: "Missing or invalid (using defaults)",
        });
      }

      const passed = checks.filter(c => c.ok).length;
      const failed = checks.filter(c => !c.ok).length;

      const lines = [
        `pi-engteam doctor — ${passed} passed, ${failed} issues`,
        "",
        ...checks.map(c => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.message}`),
        "",
        failed > 0
          ? "Run 'pnpm install:extension' to fix missing files."
          : "All checks passed.",
      ];

      return { message: lines.join("\n") };
    },
  });
}
```

### Step 4 — Wire into `src/index.ts`

`src/index.ts` is currently a stub (`export {};`). This task begins populating it. Later tasks (26) will complete it. For now, add the doctor command registration alongside a minimal shell that can be fleshed out in Task 26:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerDoctorCommand } from "./commands/doctor.js";

export default async function (pi: ExtensionAPI) {
  registerDoctorCommand(pi);
  // Additional commands and the ADWEngine will be wired in Task 26
}
```

### Step 5 — Run tests and verify pass

```bash
pnpm test tests/unit/commands/doctor.test.ts
# Expected: all 5 assertions green
```

### Step 6 — Commit

```bash
git add src/commands/doctor.ts tests/unit/commands/doctor.test.ts src/index.ts
git commit -m "feat: engteam-doctor command for installation health check"
```

---

## Task 23: Integration Test — MessageBus

### Files

- `tests/integration/team-boot.test.ts`

### Step 1 — Write the failing test

```bash
mkdir -p tests/integration
```

Create `tests/integration/team-boot.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageBus } from "../../src/team/MessageBus.js";
import type { TeamMessage } from "../../src/types.js";

describe("MessageBus integration", () => {
  it("routes a message to its named subscriber", async () => {
    const bus = new MessageBus();
    const received: TeamMessage[] = [];

    bus.subscribe("alice", (msg) => {
      received.push(msg);
      return Promise.resolve();
    });

    await bus.send({
      id: "1",
      from: "bob",
      to: "alice",
      summary: "hello",
      message: "hi there",
      ts: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].from).toBe("bob");
    expect(received[0].message).toBe("hi there");
  });

  it("does not deliver to the wrong subscriber", async () => {
    const bus = new MessageBus();
    const receivedAlice: TeamMessage[] = [];
    const receivedBob: TeamMessage[] = [];

    bus.subscribe("alice", (msg) => { receivedAlice.push(msg); return Promise.resolve(); });
    bus.subscribe("bob",   (msg) => { receivedBob.push(msg);   return Promise.resolve(); });

    await bus.send({
      id: "2",
      from: "system",
      to: "alice",
      summary: "direct",
      message: "only for alice",
      ts: new Date().toISOString(),
    });

    expect(receivedAlice).toHaveLength(1);
    expect(receivedBob).toHaveLength(0);
  });

  it("broadcasts to all subscribers except the sender", async () => {
    const bus = new MessageBus();
    const receivedA: TeamMessage[] = [];
    const receivedB: TeamMessage[] = [];

    bus.subscribe("alpha", (msg) => { receivedA.push(msg); return Promise.resolve(); });
    bus.subscribe("beta",  (msg) => { receivedB.push(msg); return Promise.resolve(); });

    await bus.broadcast("system", "hello all", "broadcast message");

    expect(receivedA.length).toBeGreaterThan(0);
    expect(receivedB.length).toBeGreaterThan(0);
  });

  it("broadcast excludes the sender", async () => {
    const bus = new MessageBus();
    const receivedSelf: TeamMessage[] = [];
    const receivedOther: TeamMessage[] = [];

    bus.subscribe("sender", (msg) => { receivedSelf.push(msg); return Promise.resolve(); });
    bus.subscribe("other",  (msg) => { receivedOther.push(msg); return Promise.resolve(); });

    await bus.broadcast("sender", "test", "should not receive own broadcast");

    expect(receivedSelf).toHaveLength(0);
    expect(receivedOther).toHaveLength(1);
  });

  it("unsubscribe removes the handler", async () => {
    const bus = new MessageBus();
    const received: TeamMessage[] = [];

    const unsubscribe = bus.subscribe("target", (msg) => {
      received.push(msg);
      return Promise.resolve();
    });

    unsubscribe();

    await bus.send({
      id: "3",
      from: "src",
      to: "target",
      summary: "after unsub",
      message: "should not arrive",
      ts: new Date().toISOString(),
    });

    expect(received).toHaveLength(0);
  });

  it("subscribeAll receives every message regardless of recipient", async () => {
    const bus = new MessageBus();
    const allMessages: TeamMessage[] = [];

    bus.subscribeAll((msg) => { allMessages.push(msg); return Promise.resolve(); });
    bus.subscribe("alice", () => Promise.resolve());
    bus.subscribe("bob",   () => Promise.resolve());

    await bus.send({ id: "4", from: "x", to: "alice", summary: "s", message: "m", ts: new Date().toISOString() });
    await bus.send({ id: "5", from: "x", to: "bob",   summary: "s", message: "m", ts: new Date().toISOString() });

    expect(allMessages).toHaveLength(2);
  });
});
```

### Step 2 — Run tests

```bash
pnpm test tests/integration/team-boot.test.ts
# Expected: all 6 assertions green (MessageBus is already implemented)
```

If any fail, investigate the `MessageBus.send` broadcast path — the `msg.from === msg.to` skipping condition needs to match "sender skips self" semantics.

---

## Task 24: Integration Test — Plan-Build-Review Workflow

### Files

- `tests/integration/plan-build-review.test.ts`

### Step 1 — Write the test

Create `tests/integration/plan-build-review.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ADWEngine } from "../../src/adw/ADWEngine.js";
import { planBuildReview } from "../../src/workflows/plan-build-review.js";
import type { VerdictPayload } from "../../src/types.js";

describe("plan-build-review workflow integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "eng-integ-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("runs plan→build→review to succeeded status when all agents PASS", async () => {
    const mockObserver = { emit: vi.fn() } as any;

    const mockTeam = {
      deliver: vi.fn(),
    } as any;

    const workflows = new Map([["plan-build-review", planBuildReview]]);

    const engine = new ADWEngine({
      runsDir: tmpDir,
      workflows,
      team: mockTeam,
      observer: mockObserver,
    });

    // When deliver is called, immediately notify the engine with a PASS verdict for that step
    mockTeam.deliver.mockImplementation(async (_agentName: string, msg: any) => {
      const stepName = (msg.summary as string)?.replace("Execute step: ", "") ?? "unknown";
      // Use setImmediate to simulate the async agent responding after the current microtask
      setImmediate(() => {
        engine.notifyVerdict({
          step: stepName,
          verdict: "PASS",
          artifacts: [`${stepName}-output.md`],
        } satisfies VerdictPayload);
      });
    });

    const state = await engine.startRun({
      workflow: "plan-build-review",
      goal: "Add a hello world function",
      budget: { maxIterations: 10, maxCostUsd: 50, maxWallSeconds: 60 },
    });

    const finalState = await engine.executeRun(state.runId);

    expect(finalState.status).toBe("succeeded");
    expect(finalState.steps.length).toBeGreaterThanOrEqual(3);
    expect(finalState.steps.map(s => s.name)).toContain("plan");
    expect(finalState.steps.map(s => s.name)).toContain("build");
    expect(finalState.steps.map(s => s.name)).toContain("review");
  });

  it("halts with failed status when plan step returns FAIL", async () => {
    const mockObserver = { emit: vi.fn() } as any;
    const mockTeam = { deliver: vi.fn() } as any;
    const workflows = new Map([["plan-build-review", planBuildReview]]);

    const engine = new ADWEngine({
      runsDir: tmpDir,
      workflows,
      team: mockTeam,
      observer: mockObserver,
    });

    mockTeam.deliver.mockImplementation(async (_agentName: string, msg: any) => {
      const stepName = (msg.summary as string)?.replace("Execute step: ", "") ?? "unknown";
      setImmediate(() => {
        engine.notifyVerdict({
          step: stepName,
          verdict: "FAIL",
          issues: ["Goal is not feasible"],
        } satisfies VerdictPayload);
      });
    });

    const state = await engine.startRun({
      workflow: "plan-build-review",
      goal: "Do something impossible",
      budget: { maxIterations: 10, maxCostUsd: 50, maxWallSeconds: 60 },
    });

    const finalState = await engine.executeRun(state.runId);

    expect(finalState.status).toBe("failed");
    // Should have stopped after plan — build should never run
    expect(finalState.steps.map(s => s.name)).not.toContain("build");
  });

  it("persists final state to disk after completion", async () => {
    const mockObserver = { emit: vi.fn() } as any;
    const mockTeam = { deliver: vi.fn() } as any;
    const workflows = new Map([["plan-build-review", planBuildReview]]);

    const engine = new ADWEngine({
      runsDir: tmpDir,
      workflows,
      team: mockTeam,
      observer: mockObserver,
    });

    mockTeam.deliver.mockImplementation(async (_agentName: string, msg: any) => {
      const stepName = (msg.summary as string)?.replace("Execute step: ", "") ?? "unknown";
      setImmediate(() => {
        engine.notifyVerdict({ step: stepName, verdict: "PASS", artifacts: [] });
      });
    });

    const state = await engine.startRun({
      workflow: "plan-build-review",
      goal: "Persistence test",
      budget: { maxIterations: 10, maxCostUsd: 50, maxWallSeconds: 60 },
    });

    await engine.executeRun(state.runId);

    // Verify state was persisted to disk by loading it independently
    const { loadRunState } = await import("../../src/adw/RunState.js");
    const loaded = await loadRunState(tmpDir, state.runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe("succeeded");
    expect(loaded?.runId).toBe(state.runId);
  });
});
```

### Step 2 — Run tests

```bash
pnpm test tests/integration/plan-build-review.test.ts
# Expected: all 3 assertions green
```

**Known integration concern:** The `waitForAgentVerdict` in `plan-build-review.ts` has a 10-minute timeout. The mock uses `setImmediate` to call `notifyVerdict` asynchronously after the Promise is created, which correctly simulates an agent responding. If tests hang, verify that `registerVerdictListener` is being called before `deliver` in the step implementation — the order matters for the mock to work.

---

## Task 25: Integration Test — Safety Classifier

### Files

- `tests/integration/safety-guard.test.ts`

### Step 1 — Write the test

Create `tests/integration/safety-guard.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyCommand } from "../../src/safety/classifier.js";

describe("classifier integration", () => {
  // Blocked: hard-stop patterns
  it("blocks rm -rf /", () => {
    const result = classifyCommand("rm -rf /");
    expect(result.classification).toBe("blocked");
  });

  it("blocks rm -rf ~", () => {
    const result = classifyCommand("rm -rf ~");
    expect(result.classification).toBe("blocked");
  });

  it("blocks git push --force", () => {
    const result = classifyCommand("git push --force");
    expect(result.classification).toBe("blocked");
  });

  it("blocks git push -f origin main", () => {
    const result = classifyCommand("git push -f origin main");
    expect(result.classification).toBe("blocked");
  });

  it("blocks sudo commands", () => {
    const result = classifyCommand("sudo rm -rf /tmp/foo");
    expect(result.classification).toBe("blocked");
  });

  it("blocks npm publish", () => {
    const result = classifyCommand("npm publish");
    expect(result.classification).toBe("blocked");
  });

  // Safe: read-only operations
  it("allows git status", () => {
    const result = classifyCommand("git status");
    expect(result.classification).toBe("safe");
  });

  it("allows git diff", () => {
    const result = classifyCommand("git diff HEAD~1");
    expect(result.classification).toBe("safe");
  });

  it("allows git log", () => {
    const result = classifyCommand("git log --oneline -10");
    expect(result.classification).toBe("safe");
  });

  it("allows pnpm test", () => {
    const result = classifyCommand("pnpm test");
    expect(result.classification).toBe("safe");
  });

  it("allows vitest run", () => {
    const result = classifyCommand("vitest run");
    expect(result.classification).toBe("safe");
  });

  it("allows cat", () => {
    const result = classifyCommand("cat src/index.ts");
    expect(result.classification).toBe("safe");
  });

  it("allows grep", () => {
    const result = classifyCommand("grep -r 'export' src/");
    expect(result.classification).toBe("safe");
  });

  // Destructive: requires approval but not blocked
  it("marks git push origin main as destructive", () => {
    const result = classifyCommand("git push origin main");
    expect(result.classification).toBe("destructive");
  });

  it("marks git commit as destructive", () => {
    const result = classifyCommand("git commit -m 'wip'");
    expect(result.classification).toBe("destructive");
  });

  it("marks pnpm install as destructive", () => {
    const result = classifyCommand("pnpm install");
    expect(result.classification).toBe("destructive");
  });

  it("marks node script execution as destructive", () => {
    const result = classifyCommand("node scripts/migrate.js");
    expect(result.classification).toBe("destructive");
  });

  it("marks sed -i as destructive", () => {
    const result = classifyCommand("sed -i 's/foo/bar/g' file.ts");
    expect(result.classification).toBe("destructive");
  });

  // Compound commands — worst classification wins
  it("blocks a compound command if any segment is blocked", () => {
    const result = classifyCommand("git status && rm -rf /");
    expect(result.classification).toBe("blocked");
  });

  it("marks compound as destructive if any segment is destructive and none blocked", () => {
    const result = classifyCommand("git log && git commit -m 'fix'");
    expect(result.classification).toBe("destructive");
  });
});
```

### Step 2 — Run tests

```bash
pnpm test tests/integration/safety-guard.test.ts
# Expected: all 20 assertions green
```

If any test fails, check the `patterns.ts` and `paths.ts` implementations to ensure the relevant pattern is covered. The classifier is already fully implemented, so all tests should pass without code changes.

### Step 3 — Commit all three integration test files together

```bash
git add tests/integration/team-boot.test.ts \
        tests/integration/plan-build-review.test.ts \
        tests/integration/safety-guard.test.ts
git commit -m "test: integration tests for MessageBus, plan-build-review workflow, and safety classifier"
```

---

## Task 26: Wire All Workflows into `src/index.ts`

### Files

- `src/index.ts` (full rewrite from the Task 22 stub)
- `src/commands/run-start.ts` (description update)

### Step 1 — Write a failing smoke test

Create `tests/unit/index.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({}));

describe("extension entry point", () => {
  it("exports a default async function", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof mod.default).toBe("function");
  });
});
```

### Step 2 — Verify test passes for the current stub state

```bash
pnpm test tests/unit/index.test.ts
# The stub from Task 22 already exports a default function, so this passes.
```

### Step 3 — Implement the full `src/index.ts`

This wires all commands, all 9 workflows, the ADWEngine, TeamRuntime, Observer, and SafetyGuard together into the Pi extension entry point.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join } from "path";
import { homedir } from "os";

// Commands
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerTeamStartCommand } from "./commands/team-start.js";
import { registerTeamStopCommand } from "./commands/team-stop.js";
import { registerRunStartCommand } from "./commands/run-start.js";
import { registerRunResumeCommand } from "./commands/run-resume.js";
import { registerRunAbortCommand } from "./commands/run-abort.js";
import { registerRunStatusCommand } from "./commands/run-status.js";

// Workflows
import { planBuildReview } from "./workflows/plan-build-review.js";
import { migration } from "./workflows/migration.js";
import { refactorCampaign } from "./workflows/refactor-campaign.js";
import { docBackfill } from "./workflows/doc-backfill.js";

// Core infrastructure
import { ADWEngine } from "./adw/ADWEngine.js";
import { TeamRuntime } from "./team/TeamRuntime.js";
import { Observer } from "./observer/Observer.js";
import { loadConfig } from "./config.js";

export default async function (pi: ExtensionAPI) {
  const home = homedir();
  const engteamDir = join(home, ".pi", "engteam");
  const runsDir = join(engteamDir, "runs");

  // Load configuration (falls back to safe defaults if absent)
  const config = await loadConfig(engteamDir);

  // Wire up observer (writes to ~/.pi/engteam/runs/<runId>/events.jsonl)
  const observer = new Observer({ runsDir });

  // Wire up team runtime (manages agent sessions)
  const team = new TeamRuntime(pi, config);

  // Register all workflows
  const workflows = new Map([
    ["plan-build-review", planBuildReview],
    ["migration", migration],
    ["refactor-campaign", refactorCampaign],
    ["doc-backfill", docBackfill],
  ]);

  // Wire up engine
  const engine = new ADWEngine({ runsDir, workflows, team, observer });

  // Register all commands
  registerDoctorCommand(pi);
  registerTeamStartCommand(pi, team);
  registerTeamStopCommand(pi, team);
  registerRunStartCommand(pi, engine);
  registerRunResumeCommand(pi, engine);
  registerRunAbortCommand(pi, engine);
  registerRunStatusCommand(pi, engine);
}
```

**Note:** The `investigate`, `triage`, `verify`, `debug`, and `fix-loop` workflows referenced in the prompt's import list are planned for Plan B Section 4. The `src/index.ts` above includes only the four workflows implemented in Plan B Sections 1–3. The workflows map is easily extended: add the import and a `[name, workflow]` entry.

### Step 4 — Update `src/commands/run-start.ts` workflow description

In `src/commands/run-start.ts`, update the `workflow` parameter description to list all currently registered workflows:

```typescript
workflow: Type.String({
  description: "Workflow name: plan-build-review | migration | refactor-campaign | doc-backfill",
}),
```

### Step 5 — Run full test suite

```bash
pnpm build && pnpm test
# Expected: all unit and integration tests pass, build succeeds
```

### Step 6 — Commit

```bash
git add src/index.ts src/commands/run-start.ts tests/unit/index.test.ts
git commit -m "feat: register all workflows and commands in extension entry point"
```

---

## Task 27: Finalize `package.json` and Verify Full Build + Test

### Files

- `package.json` (final script additions)

### Step 1 — Add remaining scripts to `package.json`

The final `scripts` block (incorporating Task 21 scripts plus these additions):

```json
"scripts": {
  "build": "tsup",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit",
  "install:extension": "bash scripts/install.sh",
  "uninstall:extension": "bash scripts/uninstall.sh",
  "engteam:install": "pnpm build && bash scripts/install.sh",
  "engteam:doctor": "node -e \"import('./dist/index.js').then(() => console.log('Extension loads OK')).catch(e => { console.error(e); process.exit(1); })\""
}
```

**Important:** The `engteam:doctor` script uses dynamic ESM import (the project is `"type": "module"`) rather than `require`. The `-e` flag with an ESM `import()` expression works in Node ≥ 14.

### Step 2 — Run the full build and test pipeline

```bash
pnpm build
# Expected: dist/index.js emitted by tsup with no errors

pnpm typecheck
# Expected: zero TypeScript errors

pnpm test
# Expected: all unit tests pass, all integration tests pass

pnpm test tests/integration/
# Subset run to confirm integration tests run standalone
```

### Step 3 — Smoke test the built extension loads

```bash
pnpm engteam:doctor
# Expected: "Extension loads OK" (or a graceful error if Pi runtime is not present — not a crash)
```

### Step 4 — Commit

```bash
git add package.json
git commit -m "chore: package.json scripts for install workflow and doctor smoke test"
```

---

## Full Task Checklist

| # | Task | Files | Test | Status |
|---|------|-------|------|--------|
| 18 | Migration workflow | `src/workflows/migration.ts` | `tests/unit/workflows/migration.test.ts` | |
| 19 | Refactor-campaign workflow | `src/workflows/refactor-campaign.ts` | `tests/unit/workflows/refactor-campaign.test.ts` | |
| 20 | Doc-backfill workflow | `src/workflows/doc-backfill.ts` | `tests/unit/workflows/doc-backfill.test.ts` | |
| 21 | Install scripts | `scripts/install.sh`, `scripts/uninstall.sh`, `package.json` | Manual | |
| 22 | Doctor command | `src/commands/doctor.ts`, `src/index.ts` | `tests/unit/commands/doctor.test.ts` | |
| 23 | Integration: MessageBus | — | `tests/integration/team-boot.test.ts` | |
| 24 | Integration: plan-build-review | — | `tests/integration/plan-build-review.test.ts` | |
| 25 | Integration: safety classifier | — | `tests/integration/safety-guard.test.ts` | |
| 26 | Wire all workflows into index.ts | `src/index.ts`, `src/commands/run-start.ts` | `tests/unit/index.test.ts` | |
| 27 | Finalize package.json + full build | `package.json` | `pnpm build && pnpm test` | |

---

## TDD Protocol (all tasks)

Each task follows this sequence without exception:

1. **Write test** — create the test file with all assertions. The file must import from the not-yet-created implementation path.
2. **Verify fail** — run `pnpm test <test-file>` and confirm it fails with "Cannot find module" or equivalent. Do not proceed if it accidentally passes.
3. **Implement** — create the source file. Do not change the test.
4. **Run tests** — run `pnpm test <test-file>`. All assertions must be green.
5. **Commit** — stage only the source file and test file. Use the commit message in the task.

Integration tests (Tasks 23–25) follow the same protocol except that the implementation files already exist — step 2 will fail only if there is a genuine bug in the existing code, in which case fix the bug before committing the test.


---

