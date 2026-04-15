# Design: OMC Improvements → pi-engteam

**Date:** 2026-04-15  
**Source:** Collaborative brainstorming session — analysis of [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)  
**Approach:** Surgical upgrades only — no new agents, no new commands, no structural changes  
**Status:** Approved for planning

---

## Overview

Analysis of the oh-my-claudecode (OMC) multi-agent framework identified five battle-tested improvements applicable to pi-engteam without adding complexity or new agents. All changes are either agent prompt upgrades or small TypeScript extensions to existing types and modules.

**Primary use cases served:** Feature development (plan → build → review) and bug hunting / incident investigation.

---

## Scope

| Change | Files Affected |
|---|---|
| 1. Competing-hypothesis protocol | `agents/engteam-root-cause-debugger.md`, `agents/engteam-incident-investigator.md` |
| 2. Requirements-gap-analysis phase | `agents/engteam-planner.md` |
| 3. Evidence-based verification | `agents/engteam-reviewer.md` |
| 4. Context budget management | `agents/engteam-codebase-cartographer.md`, `agents/engteam-knowledge-retriever.md` |
| 5. Wisdom integration | `src/types.ts`, `src/team/tools/VerdictEmit.ts`, `src/memory/MemoryCore.ts`, `second-brain/scripts/lib/logWriter.mjs`, all agent `.md` files (VerdictEmit guidance) |

**Explicitly out of scope:**
- New agents (`explore`, `tracer`, `analyst`, `critic`)
- New commands or workflows
- Safety system, ADWEngine, or observability server changes
- Agent model assignment changes

---

## Change 1 — Competing-Hypothesis Protocol

**Agents:** `engteam-root-cause-debugger`, `engteam-incident-investigator`  
**Source:** OMC `tracer` agent

### Problem

Both agents currently produce a single hypothesis and chase it. This causes premature certainty, confirmation bias, and wasted investigation cycles when the first hypothesis is wrong.

### Design

Add a mandatory structured investigation protocol to both agents replacing the current freeform "gather context → analyze" approach.

#### Evidence Strength Hierarchy

Agents must rank evidence — all support is not equal:

1. Controlled reproduction / direct experiment / uniquely discriminating artifact
2. Primary artifacts with tight provenance (logs, traces, metrics, git blame, file:line behavior)
3. Multiple independent sources converging on the same explanation
4. Single-source code-path or behavioral inference
5. Weak circumstantial clues (timing, naming, stack order, resemblance to prior incidents)
6. Intuition / analogy / speculation

Hypotheses supported only by tiers 5–6 must be explicitly down-ranked when stronger contradictory evidence exists.

#### Investigation Protocol

1. **Observe** — restate the symptom precisely, without interpretation
2. **Hypothesize** — generate ≥2 competing causal explanations using different frames:
   - Code-path / implementation cause
   - Config / environment / orchestration cause
   - Measurement / artifact / assumption mismatch cause
3. **Gather evidence** — for each hypothesis: evidence for, evidence against, gaps
4. **Rebuttal round** — actively seek the strongest disconfirming evidence for the leading hypothesis
5. **Rank** — down-rank explanations contradicted by evidence or requiring unverified assumptions
6. **Synthesize** — state the current best explanation and why it outranks alternatives
7. **Probe** — name the critical unknown and the single highest-value next investigation step

#### Hard Constraints

- Generate ≥2 competing hypotheses before investigating — never chase a single theory
- Collect evidence *against* the favored explanation, not just for it
- After 3 failed hypotheses, stop and escalate to `architect` (circuit breaker)
- Never claim convergence unless hypotheses reduce to the same root cause
- Always end with a discriminating probe — never end with "not sure"
- Do not collapse into a generic fix loop; explanation before implementation

#### Output Format

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

#### Difference Between the Two Agents

The protocol is identical; the tool emphasis differs:
- `root-cause-debugger`: code-path focus — `git blame`, `lsp_diagnostics`, call stacks, file:line evidence
- `incident-investigator`: system-signal focus — `events.jsonl`, metrics, logs, recent commits, config changes

---

## Change 2 — Requirements-Gap-Analysis Phase

**Agent:** `engteam-planner`  
**Source:** OMC `analyst` agent

### Problem

The planner jumps from receiving a goal to decomposing it into tasks. Implementation starts on incomplete requirements. Gaps surface during or after build — the most expensive time to discover them.

### Design

Add a mandatory pre-planning phase that runs before `plan.md` is written. The phase evaluates the goal across six lenses:

| Lens | Question |
|---|---|
| Missing questions | What hasn't been asked that could change the implementation? |
| Undefined guardrails | What needs concrete bounds (limits, timeouts, sizes, budgets)? |
| Scope risks | What areas are prone to creep, and how do we prevent it? |
| Unvalidated assumptions | What is being assumed without validation? How would we check it? |
| Missing acceptance criteria | What does success look like in measurable, pass/fail terms? |
| Edge cases | What unusual inputs, states, or timing conditions could break this? |

#### Hard Constraints

- Findings must be **specific and actionable** — not "requirements are unclear" but "error handling for `createUser()` when email already exists is unspecified — return 409 or silent update?"
- Acceptance criteria must be **testable** (pass/fail, not subjective)
- Focus on **implementability**, not market value — "can we build this clearly?" not "should we build this?"
- If no gaps are found, the phase takes one sentence — zero overhead for clear goals

#### Plan Output Changes

`plan.md` gains two additions:

```markdown
## Open Questions          ← only present when gaps found; blocking items pause the build gate
- [ ] Should createUser() return 409 or silently update on duplicate email? — blocks error handling in step 3

## Acceptance Criteria     ← upgraded from vague to testable pass/fail
- [ ] POST /users returns 409 with { error: "email_exists" } when email already registered
- [ ] File upload rejects payloads > N bytes with 413
```

#### Open Questions Gate

If `plan.md` contains open questions marked as blocking, the workflow pauses for human input before build starts — same mechanism as the existing `/spec` approval gate. Non-blocking questions are noted but do not pause execution.

---

## Change 3 — Evidence-Based Verification

**Agent:** `engteam-reviewer`  
**Source:** OMC `verifier` agent

### Problem

The reviewer can call `VerdictEmit` with `verdict: "PASS"` after asserting "tests pass" without showing output. Words like "should", "probably", and "seems to" are accepted as evidence.

### Design

Add three mandatory evidence gates that must be satisfied before any `PASS` verdict.

#### Gate 1 — Fresh Test Output

The reviewer must run the test suite and include actual output. Rejected:
- "All tests pass" (assertion without output)
- "Tests should pass" / "tests probably pass" (speculation)
- Test output from an earlier step in the same run (stale evidence)

#### Gate 2 — Type Diagnostics

For any TypeScript changes, `lsp_diagnostics` must be run on every modified file. Zero type errors required for `PASS`. If diagnostics cannot be run, the reviewer must state that explicitly.

#### Gate 3 — Acceptance Criteria Coverage

Each criterion from `plan.md` receives a status:
- `VERIFIED` — test exists, passes, covers criterion including edge cases
- `PARTIAL` — test exists but doesn't cover all edges
- `MISSING` — no test exists for this criterion

A `PASS` verdict requires all criteria at `VERIFIED` or `PARTIAL` with documented gaps. Any `MISSING` on a critical criterion forces `FAIL`.

#### Hard Constraints

- Never `PASS` with CRITICAL or HIGH severity issues outstanding
- Never skip Gate 1 regardless of confidence level
- Words like "should", "probably", "seems to" in a verdict are automatic flags — replace with evidence
- Trivial changes (single line, typo fix, no behavior change) exempt from Gates 1 and 3 but not Gate 2

#### Review Report Format Addition

```markdown
### Evidence
- Test suite: `pnpm test` — 47 passed, 0 failed
- Type check: `lsp_diagnostics` on 3 modified files — 0 errors

### Acceptance Criteria
- [VERIFIED] POST /users returns 409 on duplicate email — covered by users.test.ts:88
- [PARTIAL]  File upload rejects > N bytes — happy path tested, concurrent upload not covered
- [MISSING]  Rate limiting after 100 requests — no test exists
```

---

## Change 4 — Context Budget Management

**Agents:** `engteam-codebase-cartographer`, `engteam-knowledge-retriever`  
**Source:** OMC `explore` agent

### Problem

Both agents read large files in full when a structural outline would suffice. This consumes context window that downstream agents (particularly `implementer`) need for reasoning and writing code.

### Design

Add a set of hard reading rules to both agents.

#### Reading Rules

| Situation | Rule |
|---|---|
| Before reading any file | Check size first via `wc -l` or `lsp_document_symbols` |
| File ≤ 200 lines | Read normally |
| File 200–500 lines | Get outline via `lsp_document_symbols` first; read only needed sections with `offset`/`limit` |
| File > 500 lines | Always use `lsp_document_symbols` unless caller explicitly requested full content |
| Batch reads | Cap at 5 files in parallel per round; queue additional reads in subsequent rounds |
| Large file required | Use `Read` with `limit: 100`; note "File truncated — use offset to read more" |
| Tool preference | Prefer `lsp_document_symbols`, `ast_grep_search`, `Grep` over `Read` |

#### Hard Constraints

- Never read a large file "just in case" — confirm relevance via Grep or lsp_document_symbols first
- Never run more than 5 parallel file reads in one round
- Stop a search path after 2 rounds of diminishing returns; report what was found
- All file paths in output must be absolute

#### No Output Format Change

`codebase-map.md` and `context-pack.md` artifacts are unchanged. This is a pure internal discipline addition.

---

## Change 5 — Wisdom Integration

**Affects:** `src/types.ts`, `src/team/tools/VerdictEmit.ts`, `src/memory/MemoryCore.ts`, `second-brain/scripts/lib/logWriter.mjs`, all agent `.md` files  
**Source:** OMC Notepad Wisdom System, integrated into existing Memory Core

### Problem

Agents rediscover the same codebase patterns, conventions, and gotchas across runs. Memory Core captures *what ran and what changed* but not *what agents learned* during execution. Knowledge that would help future agents is lost at session end.

### Design

Extend the existing `VerdictEmit` → `MemoryCore` → daily log pipeline with structured wisdom fields. No new tools, no new infrastructure.

#### Part A — Extended VerdictPayload (`src/types.ts`)

```typescript
export interface VerdictPayload {
  step: string;
  verdict: "PASS" | "FAIL" | "NEEDS_MORE";
  issues?: string[];           // existing: failure reasons
  artifacts?: string[];        // existing: file paths produced
  handoffHint?: string;        // existing: escalation routing
  // NEW — all optional
  learnings?: string[];        // patterns, conventions, successful approaches
  decisions?: string[];        // architectural choices made and why
  issues_found?: string[];     // problems and blockers encountered during this step
  gotchas?: string[];          // technical debt, footguns, things that will bite future agents
}
```

> `issues_found` (not `issues`) avoids collision with the existing `issues[]` failure-reason field.  
> `gotchas` (not `problems`) — more self-explanatory in agent context.

All new fields are optional. Empty arrays and omitted fields are treated identically. Zero overhead for agents with nothing to record.

#### Part B — CompletedRun Extension (`src/types.ts`)

```typescript
export interface CompletedRun {
  runId: string;
  workflow: string;
  goal: string;
  verdict: "PASS" | "FAIL" | "ABORTED";
  artifacts: string[];
  changedFiles: string[];
  completedAt: string;
  // NEW
  wisdom: {
    learnings: string[];
    decisions: string[];
    issues_found: string[];
    gotchas: string[];
  };
}
```

#### Part C — MemoryCore Capture (`src/memory/MemoryCore.ts`)

`captureRun()` is called after each step verdict. If the verdict contains wisdom fields, they are **appended** (not replaced) to the run's accumulated wisdom. Multi-step runs accumulate wisdom across all steps.

`captureAbortedRun()` initializes an empty wisdom object — aborted runs produce no wisdom.

#### Part D — Daily Log Format (`second-brain/scripts/lib/logWriter.mjs`)

A **Wisdom** section is added per run that contains at least one non-empty wisdom array. Runs with no wisdom produce no section — no noise.

```markdown
## Session abc123 — 14:32Z

### Runs
| Run ID | Workflow | Goal | Verdict |
|--------|----------|------|---------|
| `d4e5f6` | plan-build-review | Add rate limiting | PASS |

### Changed Files
- src/middleware/rateLimit.ts

### Wisdom
#### d4e5f6 — Add rate limiting

**Learnings**
- express-rate-limit stores state in-memory by default — use Redis store for multi-instance deployments

**Decisions**
- Chose sliding window over fixed window — better UX for burst-then-idle usage patterns

**Gotchas**
- RateLimitInfo headers only set when `standardHeaders: true` — easy to miss in tests

### Summary
<LLM-generated narrative>

---
```

Wisdom categories with no entries are omitted entirely within a run's wisdom block.

#### Part E — Agent Prompt Additions

All agent `.md` files receive a wisdom guidance paragraph in their `VerdictEmit` section:

> When calling `VerdictEmit`, populate the optional wisdom fields if you discovered anything worth preserving: `learnings` for patterns or conventions found in the codebase, `decisions` for architectural choices made and why, `issues_found` for problems encountered that weren't in the plan, `gotchas` for technical debt or footguns future agents should know about. Omit fields you have nothing to record — empty arrays add no value.

#### V1 Boundaries

- No query interface — agents do not read from the wisdom store during a run (future capability)
- No deduplication — same learning recorded twice appears twice
- No breaking change — all fields optional, all existing runs work identically

---

## Acceptance Criteria

- [ ] `root-cause-debugger` and `incident-investigator` always produce a hypothesis table with ≥2 entries and a discriminating probe
- [ ] `root-cause-debugger` and `incident-investigator` never produce a single-hypothesis report
- [ ] `planner` plan.md always contains testable acceptance criteria (pass/fail verifiable)
- [ ] `planner` surfaces blocking open questions in plan.md when requirements are incomplete
- [ ] `reviewer` PASS verdicts always include fresh test output and lsp_diagnostics results
- [ ] `reviewer` PASS verdicts always include acceptance criteria coverage status (VERIFIED / PARTIAL / MISSING)
- [ ] `reviewer` never issues PASS when a critical acceptance criterion is MISSING
- [ ] `codebase-cartographer` and `knowledge-retriever` never read a file > 500 lines without checking lsp_document_symbols first
- [ ] `VerdictPayload` type includes optional `learnings`, `decisions`, `issues_found`, `gotchas` fields
- [ ] `CompletedRun` type includes `wisdom` object with the four arrays
- [ ] Memory Core accumulates wisdom across steps within a run (append, not replace)
- [ ] Daily log includes Wisdom section for runs that produced wisdom entries
- [ ] Daily log omits Wisdom section entirely for runs with no wisdom entries
- [ ] All existing runs and workflows continue to work without modification

---

## Implementation Notes

### Agent files are source of truth

Agent `.md` files in `agents/` are the source — changes there are deployed by the postinstall script (`scripts/postinstall.mjs`) which copies them to `~/.pi/agent/agents/engteam-*.md`. No separate build step needed for agent changes.

### TypeScript changes require a build

Changes to `src/` need `pnpm build` (or `pnpm engteam:install`) to take effect in the deployed bundle at `~/.pi/agent/extensions/pi-engteam.js`. When loading from source via `pi install`, changes take effect on Pi restart without a build.

### logWriter.mjs is a standalone script

`second-brain/scripts/lib/logWriter.mjs` is a pure Node.js script with no TypeScript. Changes take effect immediately — no build step. The script is copied to `~/.pi/engteam/second-brain/scripts/lib/logWriter.mjs` by postinstall.

### Suggested implementation order

1. Agent prompt changes (Changes 1–4) — lowest risk, immediately testable by running workflows
2. TypeScript type extensions (Change 5, Part A+B) — additive only, no breaking changes
3. MemoryCore capture logic (Change 5, Part C) — small addition to `captureRun()`
4. logWriter format (Change 5, Part D) — update daily log builder
5. Agent VerdictEmit guidance (Change 5, Part E) — add wisdom paragraph to all agent files

---

## References

- [oh-my-claudecode repository](https://github.com/Yeachan-Heo/oh-my-claudecode) — source of all five patterns
- OMC `tracer` agent → Change 1
- OMC `analyst` agent → Change 2
- OMC `verifier` agent → Change 3
- OMC `explore` agent → Change 4
- OMC Notepad Wisdom System → Change 5
