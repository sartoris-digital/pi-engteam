# pi-engineering Rename + Karpathy Guidelines Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the extension and repo from `pi-engteam` to `pi-engineering`, migrate the runtime data directory, and embed the Andrej Karpathy coding guidelines into all 15 agent system prompts.

**Architecture:** Single big-bang PR. Two logical phases executed together: (1) mechanical rename of all identifiers/paths/names, (2) additive content change to agent files. A one-time data migration runs at the first session_start after the update.

**Tech Stack:** TypeScript, Node.js, bash scripts, Pi extension API, GitHub CLI (`gh`)

---

## Rename Map

| Old | New |
|-----|-----|
| GitHub repo | `sartoris-digital/pi-engteam` → `sartoris-digital/pi-engineering` |
| Package name | `@sartoris/pi-engteam` → `@sartoris/pi-engineering` |
| Runtime dir | `~/.pi/engteam/` → `~/.pi/engineering-team/` |
| Env var prefix | `PI_ENGTEAM_*` → `PI_ENGINEERING_*` |
| Agent file prefix | `engteam-*.md` → `engineering-*.md` |
| npm script | `engteam:install` → `engineering:install` |

### Env vars renamed

| Old | New |
|-----|-----|
| `PI_ENGTEAM_AGENT_MODE` | `PI_ENGINEERING_AGENT_MODE` |
| `PI_ENGTEAM_AGENT_NAME` | `PI_ENGINEERING_AGENT_NAME` |
| `PI_ENGTEAM_VERDICT_FILE` | `PI_ENGINEERING_VERDICT_FILE` |
| `PI_ENGTEAM_RUN_ID` | `PI_ENGINEERING_RUN_ID` |
| `PI_ENGTEAM_RUNS_DIR` | `PI_ENGINEERING_RUNS_DIR` |
| `PI_ENGTEAM_SERVER_PORT` | `PI_ENGINEERING_SERVER_PORT` |
| `PI_ENGTEAM_DATA_DIR` | `PI_ENGINEERING_TEAM_DATA_DIR` |

---

## Phase 1: Mechanical Rename

### Files to update

**Source code:**
- `src/index.ts` — `ENGTEAM_DIR` constant, console log messages, env var names
- `src/commands/observe.ts` — `PI_ENGTEAM_SERVER_PORT` → `PI_ENGINEERING_SERVER_PORT`
- `src/commands/doctor.ts` — all `pi-engteam` string references
- `src/team/TeamRuntime.ts` — all `PI_ENGTEAM_*` env var names in subprocess spawn
- `server/index.ts` — `PI_ENGTEAM_DATA_DIR`, `PI_ENGTEAM_SERVER_PORT`
- `src/config.ts` — any engteam path/name refs
- `src/memory/config.ts` — any engteam refs
- `src/memory/MemoryCore.ts` — any engteam refs

**Scripts:**
- `scripts/install.sh` — `ENGTEAM_DIR` var, all install paths, final message
- `scripts/postinstall.mjs` — `ENGTEAM_DIR`, all path constants
- `scripts/uninstall.sh` (if present)

**Config:**
- `package.json` — name field, `engteam:install` script key

**Docs:**
- `README.md` — all `pi-engteam` and `engteam` references

### Migration (in session_start)

On the first startup after the update, `src/index.ts` checks:
- If `~/.pi/engineering-team/` does not exist AND `~/.pi/engteam/` does exist → `rename` the directory atomically
- Logs: `[pi-engineering] Migrated data directory from ~/.pi/engteam to ~/.pi/engineering-team`
- If rename fails (e.g. cross-device), logs: `[pi-engineering] Could not auto-migrate data dir. Please run: mv ~/.pi/engteam ~/.pi/engineering-team`
- Never throws — migration failure must not block startup

The existing stale-run cleanup code runs after the migration check.

### GitHub repo rename

Run after all code changes are committed and pushed:
```bash
gh repo rename pi-engineering --repo sartoris-digital/pi-engteam
```

---

## Phase 2: Karpathy Guidelines in Agent System Prompts

Add the following section to all 15 agent markdown files (`agents/*.md`), placed immediately before the final `Always call VerdictEmit…` line:

```markdown
## Code Quality Guidelines

Apply these principles on every task:

1. **Think Before Coding** — State your assumptions explicitly before acting. If multiple interpretations exist, present them — don't pick one silently. If something is unclear, stop and ask.
2. **Simplicity First** — Write the minimum code that solves the problem. No speculative features, no abstractions for single-use code, no configurability that wasn't requested.
3. **Surgical Changes** — Touch only what the task requires. Don't improve adjacent code, refactor things that aren't broken, or clean up unrelated formatting. Match existing style.
4. **Goal-Driven Execution** — Before implementing, define verifiable success criteria. For multi-step work, state a brief plan with a verification check for each step.
```

The 15 agent files:
`architect.md`, `bug-triage.md`, `codebase-cartographer.md`, `implementer.md`,
`incident-investigator.md`, `issue-analyst.md`, `judge.md`, `knowledge-retriever.md`,
`observability-archivist.md`, `performance-analyst.md`, `planner.md`, `reviewer.md`,
`root-cause-debugger.md`, `security-auditor.md`, `tester.md`

---

## Error Handling

- Migration rename: wrapped in try/catch; failure → warning log with manual path, startup continues
- All env var reads: use `?? fallback` so missing vars don't crash subprocess spawn
- GitHub repo rename: done manually via CLI after push (not automated in code)

---

## Testing

- `pnpm test` — all 430 tests must pass after rename (paths are relative or use tmpdir)
- `pnpm build` — must compile clean with no TS errors
- `pnpm engineering:install` — installs to correct paths, agent files use `engineering-` prefix
- Manual: restart Pi, run `/doctor`, verify all checks pass under new name
- Manual: verify `~/.pi/engineering-team/` exists after first restart (migration ran)
