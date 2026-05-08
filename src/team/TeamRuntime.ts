import { spawn } from "child_process";
import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { basename } from "path";
import { join } from "path";
import { randomBytes } from "crypto";
import type { AgentDefinition, TeamMessage, VerdictPayload } from "../types.js";
import type { MessageBus } from "./MessageBus.js";
import type { Observer } from "../observer/Observer.js";
import type { RateLimitGuard } from "../rateLimit/RateLimitGuard.js";
import { modelToProvider } from "./modelProvider.js";

export type SubprocessEventLine = {
  category: string;
  type: string;
  payload: Record<string, unknown>;
  ts: string;
};

type TeamRuntimeConfig = {
  cwd: string;
  bus: MessageBus;
  observer: Observer;
  runsDir: string;
  /** H2: callback fired after each agent subprocess returns a verdict (replaces dead customToolsFor) */
  onVerdictReceived?: (runId: string, agentName: string, verdict: VerdictPayload) => void;
  agentDefs?: AgentDefinition[];
  /** L2: per-subprocess kill timeout in ms (default 10 minutes) */
  agentTimeoutMs?: number;
  /** Phase 1.5: rate-limit guard for outbound LLM dispatch */
  rateLimit?: RateLimitGuard;
  /** Phase 1.5: conservative token estimate per deliver, used for TPM enforcement (default 4000). */
  defaultEstimatedTokens?: number;
  /** Phase 1.5: invoked once per subprocess audit event line ingested from disk */
  onSubprocessEvent?: (runId: string, agentName: string, line: SubprocessEventLine) => void;
};

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

export class TeamRuntime {
  private knownDefs = new Map<string, AgentDefinition>();
  private currentRunId?: string;
  private agentLineCallback?: (agent: string, line: string) => void;

  constructor(private config: TeamRuntimeConfig) {
    for (const def of config.agentDefs ?? []) {
      this.knownDefs.set(def.name, def);
    }
  }

  setRunId(runId: string): void {
    this.currentRunId = runId;
  }

  /** Set (or clear) a callback that receives each line of agent subprocess stdout. */
  setAgentLineCallback(fn: ((agent: string, line: string) => void) | undefined): void {
    this.agentLineCallback = fn;
  }

  /** Called by ADWEngine before each step — no-op in subprocess mode (no persistent sessions). */
  setStepContext(_stepName: string, _allStepNames: string[]): void {}

  /** Called by ADWEngine after each step — no-op in subprocess mode. */
  markStepComplete(_stepName: string): void {}

  /** Fallback for abort/crash paths — no-op in subprocess mode. */
  clearStepContext(): void {}

  /** Register (or replace) an agent definition by name. Called by command handlers at runtime. */
  ensureTeammate(name: string, def: AgentDefinition): void {
    this.knownDefs.set(name, def);
  }

  async deliver(to: string, message: TeamMessage): Promise<VerdictPayload | undefined> {
    const def = this.knownDefs.get(to);
    if (!def) throw new Error(`Teammate '${to}' is not registered. Add it to AGENT_DEFS.`);

    const provider = modelToProvider(def.model);
    const estimatedTokens = this.config.defaultEstimatedTokens ?? 4000;
    // Per-deliver event token: lets each subprocess write to its own audit file
    // and lets the controller drain ONLY that file. Avoids parallel-deliver
    // races and stale-file replays that pid-based naming was vulnerable to.
    const eventToken = randomBytes(8).toString("hex");

    let ticket: ReturnType<RateLimitGuard["acquire"]> | undefined;
    if (this.config.rateLimit) {
      ticket = this.config.rateLimit.acquire(provider, { estimatedTokens });
      if (!ticket.ok) {
        const wait = Math.max(0, Math.min(ticket.retryAfterMs, 30_000));
        await new Promise((r) => setTimeout(r, wait));
        ticket = this.config.rateLimit.acquire(provider, { estimatedTokens });
        if (!ticket.ok) {
          throw new Error(`RateLimit blocked: provider=${provider}, reason=${ticket.reason}`);
        }
      }
    }

    // Single try/finally wraps EVERY filesystem and spawn op so a throw in
    // mkdir/writeFile/etc. still releases the rate-limit ticket. Codex round-1
    // C-1 fix.
    try {
      const tmpDir = join(this.config.runsDir, "_agent_tmp");
      await mkdir(tmpDir, { recursive: true });

      const id = message.id;
      const verdictFile = join(tmpDir, `${id}.verdict.json`);
      const systemPromptFile = join(tmpDir, `${id}.system-prompt.txt`);

      const teamSuffix =
        `\n\n---\n## Team Context\nYour name in the team is: **${to}**\n` +
        `Use SendMessage to communicate with other agents. Use VerdictEmit to signal task completion.\n` +
        `Always end your turn with VerdictEmit when you have completed your assigned step.`;

      await writeFile(systemPromptFile, def.systemPrompt + teamSuffix);

      const piArgs = ["-p", "--no-session", "--model", def.model, "--append-system-prompt", systemPromptFile, message.message];
      const { command, args } = getPiInvocation(piArgs);

      const runId = this.currentRunId ?? id;
      let proc: ReturnType<typeof spawn> | undefined;
      const killTimeout = setTimeout(() => {
        proc?.kill();
      }, this.config.agentTimeoutMs ?? 10 * 60 * 1000);

      try {
        await new Promise<void>((resolve, reject) => {
          proc = spawn(command, args, {
            cwd: this.config.cwd,
            env: {
              ...process.env,
              PI_ENGINEERING_AGENT_MODE: "1",
              PI_ENGINEERING_AGENT_NAME: to,
              PI_ENGINEERING_VERDICT_FILE: verdictFile,
              PI_ENGINEERING_RUN_ID: runId,
              PI_ENGINEERING_RUNS_DIR: this.config.runsDir,
              PI_ENGINEERING_SUBPROC_EVENT_TOKEN: eventToken,
            },
            stdio: ["inherit", "pipe", "inherit"],
          });
          if (proc.stdout) {
            proc.stdout.setEncoding("utf8");
            proc.stdout.on("data", (chunk: string) => {
              const lines = chunk.split("\n");
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) this.agentLineCallback?.(to, trimmed);
              }
            });
          }
          proc.on("close", (code, signal) => {
            if (code === 0 || code === null) resolve();
            else reject(new Error(`Agent subprocess exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`));
          });
          proc.on("error", reject);
        });
      } finally {
        clearTimeout(killTimeout);
        try { await unlink(systemPromptFile); } catch {}
        await this.ingestSubprocessEvents(runId, to, eventToken);
      }

      try {
        const data = await readFile(verdictFile, "utf8");
        await unlink(verdictFile).catch(() => {});
        const payload = JSON.parse(data) as VerdictPayload;
        this.config.onVerdictReceived?.(runId, to, payload);
        return payload;
      } catch {
        return undefined;
      }
    } finally {
      if (ticket?.ok && this.config.rateLimit) {
        this.config.rateLimit.release(ticket.ticketId);
      }
    }
  }

  // Drains ONLY the per-deliver audit file identified by eventToken. Filtering
  // by token prevents parallel deliveries from stealing each other's audit
  // events (Codex round-1 C-3) and prevents stale files from prior crashed
  // runs being misattributed to the current agent (Codex round-1 H-1).
  private async ingestSubprocessEvents(runId: string, agentName: string, eventToken: string): Promise<void> {
    if (!this.config.onSubprocessEvent) return;
    const runDir = join(this.config.runsDir, runId);
    const path = join(runDir, `events-subprocess-${eventToken}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return;
    }
    for (const rawLine of raw.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const line = JSON.parse(trimmed) as SubprocessEventLine;
        this.config.onSubprocessEvent(runId, agentName, line);
      } catch {
        // skip malformed line
      }
    }
    try { await unlink(path); } catch {}
  }

  async deliverAll(message: Omit<TeamMessage, "to">): Promise<void> {
    await Promise.all(
      Array.from(this.knownDefs.keys()).map(name =>
        this.deliver(name, { ...message, to: name })
      )
    );
  }

  getSession(_name: string): undefined {
    return undefined;
  }

  async disposeAll(): Promise<void> {
    // No persistent sessions to dispose in subprocess mode.
  }
}
