import type { ExtensionAPI, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "crypto";
import { access, constants, mkdir, readFile } from "fs/promises";
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
  generateNarrative: (
    runs: CompletedRun[],
    transcriptPath: string,
    config: MemoryConfig,
    modelRegistry: ModelRegistry | undefined,
  ) => Promise<string>;
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

// ---------------------------------------------------------------------------
// In-process narrative generation — uses Pi's configured provider via pi-ai.
// Runs inside the Pi process so the full model registry and credentials are
// already initialised by Pi. No separate API key required.
// ---------------------------------------------------------------------------

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .filter((p): p is { type: "text"; text: string } =>
      !!p && typeof p === "object" && (p as Record<string, unknown>).type === "text" &&
      typeof (p as Record<string, unknown>).text === "string",
    )
    .map((p) => p.text)
    .join(" ");
}

function extractTurn(value: unknown): { role: "user" | "assistant"; content: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const tryRole = (r: unknown, c: unknown): { role: "user" | "assistant"; content: string } | null => {
    if (r !== "user" && r !== "assistant") return null;
    const text = normalizeContent(c).trim();
    return text ? { role: r, content: text } : null;
  };
  const direct = tryRole(v.role, v.content);
  if (direct) return direct;
  if (v.type === "message" && v.message && typeof v.message === "object") {
    const m = v.message as Record<string, unknown>;
    return tryRole(m.role, m.content);
  }
  return null;
}

async function readTranscript(transcriptPath: string, maxTurns: number): Promise<string> {
  if (!transcriptPath) return "(no transcript available)";
  try {
    await access(transcriptPath, constants.F_OK);
    const raw = await readFile(transcriptPath, "utf8");
    const turns: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const turn = extractTurn(JSON.parse(line));
        if (turn) {
          const truncated = turn.content.length > 500;
          turns.push(`[${turn.role}]: ${turn.content.slice(0, 500)}${truncated ? " … [truncated]" : ""}`);
        }
      } catch { /* skip malformed lines */ }
    }
    return turns.slice(-maxTurns).join("\n\n") || "(no conversation turns found)";
  } catch {
    return "(no transcript available)";
  }
}

async function readPiSettings(): Promise<{ defaultProvider?: string; defaultModel?: string }> {
  try {
    const raw = await readFile(join(homedir(), ".pi", "agent", "settings.json"), "utf8");
    return JSON.parse(raw) as { defaultProvider?: string; defaultModel?: string };
  } catch {
    return {};
  }
}

export async function generateNarrative(
  runs: CompletedRun[],
  transcriptPath: string,
  config: MemoryConfig,
  modelRegistry: ModelRegistry | undefined,
): Promise<string> {
  try {
    if (!modelRegistry) {
      return "(narrative unavailable: model registry not initialised)";
    }

    // Use Pi's ModelRegistry to look up the configured model and its credentials.
    // This respects whatever provider and model the user has configured in Pi
    // (Anthropic, GitHub Copilot, OpenAI, etc.) without requiring a separate API key.
    const piSettings = await readPiSettings();
    const provider = piSettings.defaultProvider ?? "anthropic";
    const modelId = config.flushModel ?? piSettings.defaultModel ?? "claude-haiku-4.5";

    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      return `(narrative unavailable: model "${provider}/${modelId}" not found in Pi model registry)`;
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return `(narrative unavailable: auth error — ${auth.error})`;
    }
    const { apiKey, headers } = auth;
    if (!apiKey) {
      return "(narrative unavailable: no API key configured for model)";
    }

    const { completeSimple } = await import("@mariozechner/pi-ai");

    const runsText =
      runs.length === 0
        ? "No runs completed."
        : runs.map((r) => `- ${r.workflow}: "${r.goal}" → ${r.verdict}`).join("\n");

    const conversationText = await readTranscript(transcriptPath, config.maxConversationTurns);

    const prompt = [
      "You are summarizing a Pi engineering session.",
      "",
      "Runs completed:",
      runsText,
      "",
      `Recent conversation (last ${config.maxConversationTurns} turns):`,
      conversationText,
      "",
      "Write a 2-3 paragraph summary of what was attempted, what succeeded,",
      "what failed, and any key decisions made. Be concrete — name files,",
      "workflows, and goals. Do not pad. Do not repeat the runs list.",
    ].join("\n");

    const result = await completeSimple(
      model,
      { messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }] },
      { maxTokens: 512, apiKey, headers },
    );
    if ((result as any).stopReason === "error") {
      throw new Error((result as any).errorMessage ?? "API error");
    }
    return (
      ((result as any).content as Array<{ type: string; text?: string }> | undefined)
        ?.find((p) => p.type === "text")?.text ?? "(empty response)"
    );
  } catch (err) {
    console.error("[pi-memory] narrative generation failed:", err instanceof Error ? err.message : String(err));
    return "(narrative unavailable)";
  }
}

export class MemoryCore {
  private readonly runCache = new Map<string, CompletedRun>();
  // MED-8: 12 hex chars (48-bit) — collisions at ~100 sessions/day are <0.01%
  private readonly sessionId = randomUUID().slice(0, 12);
  private readonly deps: MemoryCoreDeps;
  private readonly logDir: string;
  private readonly lastFlushPath: string;
  private transcriptPath = "";
  // Pi's model registry — set in register(), used to resolve model + credentials
  // for in-process narrative generation without a hardcoded API key.
  private modelRegistry?: ModelRegistry;
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
      generateNarrative,
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

    // Store Pi's model registry so doFlush can resolve provider credentials.
    this.modelRegistry = (pi as any).modelRegistry as ModelRegistry | undefined;

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
      wisdom: { learnings: [], decisions: [], issues_found: [], gotchas: [] },
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

    // Generate the narrative in-process using Pi's configured provider.
    // modelRegistry comes from pi.modelRegistry (set in register()), so it uses
    // whatever model/provider the user has configured in Pi — no separate key needed.
    const narrative = await this.deps.generateNarrative(runs, this.transcriptPath, this.config, this.modelRegistry);

    const snapshotPath = await this.deps.writeSnapshot(
      this.sessionId,
      runs,
      this.config,
      narrative,
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
