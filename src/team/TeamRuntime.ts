import { spawn } from "child_process";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { basename } from "path";
import { join } from "path";
import type { AgentDefinition, TeamMessage, VerdictPayload } from "../types.js";
import type { MessageBus } from "./MessageBus.js";
import type { Observer } from "../observer/Observer.js";

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

  constructor(private config: TeamRuntimeConfig) {
    for (const def of config.agentDefs ?? []) {
      this.knownDefs.set(def.name, def);
    }
  }

  setRunId(runId: string): void {
    this.currentRunId = runId;
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

    let proc: ReturnType<typeof spawn> | undefined;
    const killTimeout = setTimeout(() => {
      proc?.kill();
    }, this.config.agentTimeoutMs ?? 10 * 60 * 1000); // L2: configurable, default 10 min

    try {
      await new Promise<void>((resolve, reject) => {
        proc = spawn(command, args, {
          cwd: this.config.cwd,
          env: {
            ...process.env,
            PI_ENGTEAM_AGENT_MODE: "1",
            PI_ENGTEAM_AGENT_NAME: to,   // H3: agent name so subprocess can gate GrantApproval
            PI_ENGTEAM_VERDICT_FILE: verdictFile,
            PI_ENGTEAM_RUN_ID: this.currentRunId ?? id,
            PI_ENGTEAM_RUNS_DIR: this.config.runsDir,
          },
          stdio: "inherit",
        });
        proc.on("close", (code, signal) => {
          if (code === 0 || code === null) resolve();
          else reject(new Error(`Agent subprocess exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`));
        });
        proc.on("error", reject);
      });
    } finally {
      clearTimeout(killTimeout);
      try { await unlink(systemPromptFile); } catch {}
    }

    try {
      const data = await readFile(verdictFile, "utf8");
      await unlink(verdictFile).catch(() => {});
      const payload = JSON.parse(data) as VerdictPayload;
      // H2: fire callback so the host (index.ts) can update memory / emit observer events
      this.config.onVerdictReceived?.(this.currentRunId ?? id, to, payload);
      return payload;
    } catch {
      return undefined;
    }
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
