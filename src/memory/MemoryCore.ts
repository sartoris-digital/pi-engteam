import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "crypto";
import { mkdir, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { loadRunState } from "../adw/RunState.js";
import type { CompletedRun, MemoryConfig, VerdictPayload } from "../types.js";
import { writeSnapshot } from "./snapshot.js";
import { ensureScriptsInstalled, spawnFlush } from "./spawnFlush.js";

const SECOND_BRAIN_DIR = join(homedir(), ".pi", "engteam", "second-brain");
const LOGS_DIR = join(SECOND_BRAIN_DIR, "logs");
const LAST_FLUSH_PATH = join(SECOND_BRAIN_DIR, ".last-flush");

type MemoryCoreDeps = {
  writeSnapshot: typeof writeSnapshot;
  spawnFlush: typeof spawnFlush;
  ensureScriptsInstalled: typeof ensureScriptsInstalled;
  loadRunState: typeof loadRunState;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

type MemoryCoreOptions = Partial<MemoryCoreDeps> & {
  logDir?: string;
  lastFlushPath?: string;
};

// MED-6: tightened file-path heuristic — only known source extensions, never URLs
function isLikelyFilePath(value: string): boolean {
  if (value.startsWith("http://") || value.startsWith("https://")) return false;
  return (
    value.includes("/") ||
    value.includes("\\") ||
    /\.(ts|tsx|js|mjs|cjs|json|md|yaml|yml|sh|py|go|rs|java|css|html|sql)$/i.test(value)
  );
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export class MemoryCore {
  private readonly runCache = new Map<string, CompletedRun>();
  // MED-8: 12 hex chars (48-bit) — collisions at ~100 sessions/day are <0.01%
  private readonly sessionId = randomUUID().slice(0, 12);
  private readonly deps: MemoryCoreDeps;
  private readonly logDir: string;
  private readonly lastFlushPath: string;
  private transcriptPath = "";
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private flushInFlight?: Promise<void>;

  constructor(
    private readonly config: MemoryConfig,
    private readonly runsDir: string,
    options: MemoryCoreOptions = {},
  ) {
    const { logDir = LOGS_DIR, lastFlushPath = LAST_FLUSH_PATH, ...deps } = options;
    this.logDir = logDir;
    this.lastFlushPath = lastFlushPath;
    this.deps = {
      writeSnapshot,
      spawnFlush,
      ensureScriptsInstalled,
      loadRunState,
      setInterval,
      clearInterval,
      ...deps,
    };
  }

  async register(pi: ExtensionAPI): Promise<void> {
    await mkdir(this.logDir, { recursive: true });

    // CRITICAL-1: script installation failure must never crash the extension
    try {
      await this.deps.ensureScriptsInstalled();
    } catch (err) {
      console.error(
        "[pi-memory] Failed to install memory scripts — memory core disabled:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    pi.on("session_start", async (_event, ctx) => {
      this.transcriptPath = ctx.sessionManager.getSessionFile() ?? "";
    });

    pi.on("session_before_compact", async () => {
      await this.flush();
    });

    // CRITICAL-3: await any in-flight flush before shutdown completes
    pi.on("session_shutdown", async () => {
      await this.destroy();
    });

    this.heartbeatTimer = this.deps.setInterval(() => {
      void this.flushIfNeeded();
    }, 15 * 60 * 1000);
    this.heartbeatTimer.unref?.();
  }

  /** Called from index.ts VerdictEmit callback for every agent verdict. */
  onVerdict(runId: string, verdict: VerdictPayload): void {
    if (verdict.verdict !== "PASS" && verdict.verdict !== "FAIL") return;
    const completedVerdict = verdict as VerdictPayload & { verdict: "PASS" | "FAIL" };
    // HIGH-2: attach rejection handler — captureRun is fire-and-forget but must not crash
    void this.captureRun(runId, completedVerdict).catch((err) => {
      console.error("[pi-memory] captureRun failed:", err instanceof Error ? err.message : String(err));
    });
  }

  /** HIGH-3: called from index.ts when engine.abortRun fires — captures aborted runs. */
  onRunAborted(runId: string): void {
    void this.captureAbortedRun(runId).catch((err) => {
      console.error("[pi-memory] captureAbortedRun failed:", err instanceof Error ? err.message : String(err));
    });
  }

  getRunCache(): CompletedRun[] {
    return [...this.runCache.values()];
  }

  async flushForTest(): Promise<void> {
    await this.flush();
  }

  // CRITICAL-3: async so session_shutdown handler can await it
  async destroy(): Promise<void> {
    if (this.heartbeatTimer) {
      this.deps.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    // Await any flush that started before shutdown so the snapshot is written cleanly
    if (this.flushInFlight) {
      await this.flushInFlight;
    }
  }

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

    this.runCache.set(runId, {
      runId,
      workflow: state?.workflow ?? existing?.workflow ?? "unknown",
      goal: state?.goal ?? existing?.goal ?? "",
      verdict: verdict.verdict,
      artifacts,
      changedFiles,
      completedAt: new Date().toISOString(),
    });
  }

  // HIGH-3: separate path for aborted runs that never emitted a verdict
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
    });
  }

  private async refreshRunCache(): Promise<void> {
    await Promise.all(
      [...this.runCache.keys()].map(async (runId) => {
        const cached = this.runCache.get(runId);
        if (!cached) return;

        const state = await this.deps.loadRunState(this.runsDir, runId).catch(() => null);
        if (!state) return;

        const artifacts = dedupeStrings([...Object.values(state.artifacts), ...cached.artifacts]);
        this.runCache.set(runId, {
          ...cached,
          workflow: state.workflow,
          goal: state.goal,
          artifacts,
          changedFiles: artifacts.filter(isLikelyFilePath),
        });
      }),
    );
  }

  private async flushIfNeeded(): Promise<void> {
    const lastFlush = await this.readLastFlushTimestamp();
    const hasNewRuns = [...this.runCache.values()].some((run) => run.completedAt > lastFlush);
    if (hasNewRuns) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushInFlight) {
      return this.flushInFlight;
    }

    this.flushInFlight = this.doFlush().finally(() => {
      this.flushInFlight = undefined;
    });
    return this.flushInFlight;
  }

  private async doFlush(): Promise<void> {
    await this.refreshRunCache();

    // HIGH-4: skip entries where workflow/goal are still unknown — they add noise to the log
    const runs = this.getRunCache().filter(
      (r) => r.workflow !== "unknown" || r.goal !== "",
    );

    const snapshotPath = await this.deps.writeSnapshot(
      this.sessionId,
      runs,
      this.config,
      this.transcriptPath,
      this.logDir,
      this.lastFlushPath,   // HIGH-6: pass explicit sentinel path
    );
    this.deps.spawnFlush(snapshotPath);
  }

  private async readLastFlushTimestamp(): Promise<string> {
    try {
      return (await readFile(this.lastFlushPath, "utf8")).trim() || new Date(0).toISOString();
    } catch {
      return new Date(0).toISOString();
    }
  }
}
