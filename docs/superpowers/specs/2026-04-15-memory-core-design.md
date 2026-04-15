# Spec: Memory Core

**Date:** 2026-04-15  
**Status:** Approved  
**Subsystem:** Second Brain — Phase 1 of 6

---

## Problem

Pi's agents operate statelessly across sessions. When a session ends or the context window compacts, everything that was learned — what workflows ran, what succeeded, what failed, what decisions were made — is lost. There is no persistent record that future sessions or agents can learn from. The second brain system requires a reliable, incrementally-built daily log as its foundation before any reflection, search, or heartbeat subsystem can be built.

---

## Approach

Add a **Memory Core** module to the pi-engteam extension. It registers hooks on `pre-compact` and a 15-minute `setInterval` heartbeat. When triggered, it writes a structured context snapshot (TypeScript, synchronous, zero cost) then spawns a standalone Node script (`flush.mjs`) fire-and-forget via `child_process.spawn`. The script reads the snapshot, slices the last N JSONL transcript turns, makes one Pi Agent SDK call to write a narrative summary, and appends the result to a daily log file at `~/.pi/engteam/second-brain/logs/YYYY-MM-DD.md`. If an Obsidian vault path is configured, a symlink is created so Obsidian sees the log without any copy or sync step.

**Two-stage flush:**
```
Stage 1 (TypeScript, sync, in extension):
  collect run metadata from in-memory cache
  write /tmp/pi-flush-{sessionId}.json

Stage 2 (flush.mjs, spawned, fire-and-forget):
  read snapshot
  read last N JSONL transcript turns
  call Pi Agent SDK → narrative
  dedup-safe append to ~/.pi/engteam/second-brain/logs/YYYY-MM-DD.md
  symlink into Obsidian vault if configured
  write .last-flush sentinel
```

Downstream subsystems (Hybrid Search, Daily Reflection, Heartbeat, Obsidian Sync) all build on this foundation without modifying it.

---

## Architecture

### New files — extension

| File | Responsibility |
|------|---------------|
| `src/memory/MemoryCore.ts` | Hook registration, run cache, flush trigger logic |
| `src/memory/config.ts` | `loadMemoryConfig()` — reads and merges defaults from config file |
| `src/memory/snapshot.ts` | `writeSnapshot(sessionId, runs)` — builds and writes temp JSON file |
| `src/memory/spawnFlush.ts` | `spawnFlush(snapshotPath)` — `child_process.spawn` wrapper |

### New files — standalone scripts

Installed to `~/.pi/engteam/second-brain/scripts/` by the extension on first run.

| File | Responsibility |
|------|---------------|
| `scripts/flush.mjs` | Stage 2 flush: reads snapshot, extracts turns, calls Pi Agent SDK, writes log |
| `scripts/lib/transcript.mjs` | `readLastNTurns(path, n)` — JSONL reader |
| `scripts/lib/logWriter.mjs` | `appendOrReplaceSession(logPath, sessionId, entry)` — dedup-safe writer |
| `scripts/lib/config.mjs` | `loadConfig()` — ES module mirror of `src/memory/config.ts` |

### Modified files

| File | Change |
|------|--------|
| `src/index.ts` | Instantiate `MemoryCore`, pass `pi` + `bus`, call `memoryCore.register()` |
| `src/types.ts` | Add `MemoryConfig` interface |

### Test files

| File | Coverage |
|------|----------|
| `tests/memory/MemoryCore.test.ts` | Hook registration, run cache updates, flush trigger conditions |
| `tests/memory/snapshot.test.ts` | Snapshot serialization, temp file write |
| `tests/memory/logWriter.test.ts` | Append new session, replace existing session, dedup |
| `tests/memory/config.test.ts` | Default merging, missing file graceful fallback |

---

## Daily Log Format

One file per day at `~/.pi/engteam/second-brain/logs/YYYY-MM-DD.md`. Multiple session entries append to the same file. Re-flushes within a session replace the existing entry (matched by session ID).

```markdown
# Daily Log: 2026-04-15

## Session abc12345 — 14:32

### Runs
| Run ID | Workflow | Goal | Verdict |
|--------|----------|------|---------|
| `a1b2c3` | spec-plan-build-review | Add dark mode toggle | PASS |
| `d4e5f6` | debug | Fix auth regression | FAIL (step: build) |

### Changed Files
- src/ui/ThemeToggle.tsx
- tests/ui/ThemeToggle.test.tsx

### Summary
[2-3 paragraph narrative written by Pi Agent SDK — what was attempted,
what succeeded, what failed, key decisions made, blockers hit]

---
```

Changed files are sourced from `RunState.artifacts` — already tracked by the ADW engine, no additional scanning needed.

---

## Flush Architecture

### Context snapshot (`/tmp/pi-flush-{sessionId}.json`)

```typescript
interface FlushSnapshot {
  sessionId: string;
  timestamp: string;          // ISO 8601
  runs: Array<{
    runId: string;
    workflow: string;
    goal: string;
    verdict: string;          // "PASS" | "FAIL" | "ABORTED"
    artifacts: string[];      // artifact keys from RunState
    changedFiles: string[];   // derived from artifact paths
    completedAt: string;      // ISO 8601
  }>;
  transcriptPath: string;     // path to Pi's JSONL session file
  maxTurns: number;           // from config, default 20
  logDir: string;             // ~/.pi/engteam/second-brain/logs
  obsidianVaultPath?: string;
  obsidianDailyNotesSubdir?: string;
}
```

### flush.mjs execution steps

1. Read and parse the snapshot file
2. Read last `maxTurns` turns from `transcriptPath` using `readLastNTurns()`
3. Build the Pi Agent SDK prompt:
   ```
   You are summarizing a Pi engineering session.
   
   Runs completed:
   [structured table from snapshot]
   
   Recent conversation (last {maxTurns} turns):
   [extracted turns]
   
   Write a 2-3 paragraph summary of what was attempted, what succeeded,
   what failed, and any key decisions made. Be concrete — name files,
   workflows, and goals. Do not pad. Do not repeat the table.
   ```
4. Call Pi Agent SDK → receive narrative string
5. Build the full session entry block
6. Call `appendOrReplaceSession(logPath, sessionId, entry)`
7. If `obsidianVaultPath` configured: ensure symlink at `{vaultPath}/{subdir}/YYYY-MM-DD.md → canonicalLogPath`
8. Write `~/.pi/engteam/second-brain/.last-flush` with current ISO timestamp

### Trigger logic in `MemoryCore.ts`

```typescript
class MemoryCore {
  private runCache: CompletedRun[] = [];
  private sessionId: string;

  register(pi: ExtensionAPI, bus: MessageBus): void {
    this.sessionId = generateSessionId();

    // Subscribe to verdict events on the MessageBus (same bus used by Observer)
    // A verdict with "PASS" or "FAIL" means a run step completed — capture it
    bus.subscribe((msg) => {
      if (msg.type === "verdict" && msg.payload) {
        this.runCache.push({
          runId: msg.runId,
          workflow: msg.payload.workflow ?? "unknown",
          goal: msg.payload.goal ?? "",
          verdict: msg.payload.verdict,
          artifacts: msg.payload.artifacts ?? [],
          changedFiles: [],
          completedAt: new Date().toISOString(),
        });
      }
    });

    // Always flush on pre-compact
    pi.on("pre-compact", async () => {
      await this.flush();
    });

    // Flush on heartbeat only if new activity since last flush
    setInterval(async () => {
      const lastFlush = await readLastFlushTimestamp();
      const hasNewRuns = this.runCache.some(r => r.completedAt > lastFlush);
      if (hasNewRuns) await this.flush();
    }, 15 * 60 * 1000);
  }

  private async flush(): Promise<void> {
    const snapshotPath = await writeSnapshot(this.sessionId, this.runCache);
    spawnFlush(snapshotPath); // fire-and-forget
  }
}
```

---

## Config

**File:** `~/.pi/engteam/second-brain/config.json`

```json
{
  "obsidianVaultPath": "~/Documents/ObsidianVault",
  "obsidianDailyNotesSubdir": "Daily",
  "maxConversationTurns": 20,
  "flushModel": "claude-haiku-4-5-20251001"
}
```

All fields optional. Missing file is not an error — all defaults apply. Loaded once at extension startup and passed into `MemoryCore`.

```typescript
interface MemoryConfig {
  obsidianVaultPath?: string;
  obsidianDailyNotesSubdir: string;   // default: "Daily"
  maxConversationTurns: number;       // default: 20
  flushModel: string;                 // default: "claude-haiku-4-5-20251001"
}
```

`loadMemoryConfig()` expands `~` in paths using `os.homedir()`.

---

## Obsidian Sync

After each flush write, `flush.mjs` creates a symlink if `obsidianVaultPath` is set:

```
canonical:  ~/.pi/engteam/second-brain/logs/2026-04-15.md
symlink:    ~/Documents/ObsidianVault/Daily/2026-04-15.md → canonical
```

Rules:
- If the symlink doesn't exist → create it
- If it already exists and points to the canonical path → no-op
- If it exists and points elsewhere → leave it (user manages their vault; never clobber)
- If the vault subdir doesn't exist → create it with `mkdir -p`

The future Obsidian Sync subsystem (Phase 6) will add `git push` from the canonical directory. The symlink approach means there is exactly one file — no divergence, no copy step.

---

## Script Installation

On first `register()` call, `MemoryCore` checks whether `~/.pi/engteam/second-brain/scripts/flush.mjs` exists. If not, it copies the scripts from the extension's bundled `assets/second-brain/scripts/` directory. This ensures the scripts are always present without requiring a separate install step.

Script source lives at: `src/assets/second-brain/scripts/` — bundled with the extension and copied at runtime.

---

## Acceptance Criteria

- On `pre-compact`, a flush fires within the same event tick (snapshot write is sync; spawn is async but immediate)
- On the 15-minute heartbeat, flush fires only if `runCache` contains entries newer than `.last-flush`
- `flush.mjs` produces a valid daily log entry with all four sections (Runs table, Changed Files, Summary, `---` separator)
- If a session entry already exists in today's log, re-flush replaces it rather than duplicating
- If `obsidianVaultPath` is set, a symlink exists at `{vaultPath}/{subdir}/YYYY-MM-DD.md` after each flush
- If `obsidianVaultPath` is not set, no symlink operations are attempted and no error is thrown
- If `config.json` does not exist, Memory Core starts successfully with all defaults
- If the flush script is not installed, `MemoryCore.register()` installs it from bundled assets before returning
- `/plan`, `/spec`, `/issue`, and all existing commands continue to work exactly as before

---

## Out of Scope

- Hybrid search over daily logs (Phase 2)
- Daily reflection and long-term memory promotion (Phase 3)
- Proactive heartbeat that calls integrations APIs (Phase 4 — the 15-min interval here only triggers flush)
- Email, calendar, tasks, community integrations (Phase 5)
- Git push for remote Obsidian sync (Phase 6)
- Encryption of log files
- Log rotation or pruning
- Multiple vault paths

---

## Open Questions

- Does Pi's `ExtensionAPI` expose a `session_end` event in addition to `pre-compact`? If so, should it also trigger a flush? (The 15-min heartbeat provides coverage, but a true session-end flush would be cleaner.)
- What is the canonical path to Pi's JSONL session transcript? The reference implementation reads from `~/.claude/projects/.../session.jsonl`. Pi's path may differ — `flush.mjs` should accept the path from the snapshot rather than hardcoding it.
- Does Pi's Agent SDK support being called from a spawned child process outside the extension context, or does it require the extension's runtime environment?
