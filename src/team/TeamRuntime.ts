import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition, TeamMessage } from "../types.js";
import type { MessageBus } from "./MessageBus.js";
import type { Observer } from "../observer/Observer.js";

type TeamRuntimeConfig = {
  cwd: string;
  bus: MessageBus;
  observer: Observer;
  runsDir: string;
  customToolsFor: (agentName: string) => any[];
};

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class TeamRuntime {
  private sessions = new Map<string, AgentSession>();
  private currentStepContext: { name: string } | null = null;
  private completedSteps = new Set<string>();
  private allSteps: string[] = [];

  constructor(private config: TeamRuntimeConfig) {}

  private teamSuffix(name: string): string {
    return `\n\n---\n## Team Context\nYour name in the team is: **${name}**\nUse SendMessage to communicate with other agents. Use VerdictEmit to signal task completion.\nAlways end your turn with VerdictEmit when you have completed your assigned step.`;
  }

  setStepContext(stepName: string, _stepIndex: number, _totalSteps: number, allStepNames: string[]): void {
    this.currentStepContext = { name: stepName };
    this.allSteps = allStepNames;
    this.refreshAllLabels();
  }

  markStepComplete(stepName: string): void {
    this.completedSteps.add(stepName);
    this.currentStepContext = null;
    this.refreshAllLabels();
  }

  clearStepContext(): void {
    this.currentStepContext = null;
    this.refreshAllLabels();
  }

  private buildSessionLabel(agentName: string): string {
    if (this.allSteps.length === 0) return agentName;
    const indicators = this.allSteps
      .map(step => {
        if (this.completedSteps.has(step)) return `✓ ${step}`;
        if (step === this.currentStepContext?.name) return `● ${step}`;
        return `○ ${step}`;
      })
      .join(" · ");
    return `${agentName} [${indicators}]`;
  }

  private refreshAllLabels(): void {
    for (const [name, session] of this.sessions) {
      session.setSessionName(this.buildSessionLabel(name));
    }
  }

  async ensureTeammate(name: string, def: AgentDefinition): Promise<void> {
    if (this.sessions.has(name)) return;

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    let model: any;
    try {
      const { getModel } = await import("@mariozechner/pi-ai");
      model = getModel("anthropic", def.model as any) ?? getModel("anthropic", "claude-sonnet-4-6");
    } catch {
      model = { id: def.model };
    }

    if (!model) throw new Error(`Model not found for agent ${name}: ${def.model}`);

    const loader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      systemPrompt: def.systemPrompt + this.teamSuffix(name),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      model,
      authStorage,
      modelRegistry,
      tools: createCodingTools(this.config.cwd),
      customTools: this.config.customToolsFor(name),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });

    this.sessions.set(name, session);
    session.setSessionName(this.buildSessionLabel(name));

    this.config.observer.subscribeToSession(
      session as any,
      "active",
      name,
    );
  }

  async ensureAllTeammates(definitions: AgentDefinition[]): Promise<void> {
    await Promise.all(definitions.map(def => this.ensureTeammate(def.name, def)));
  }

  async deliver(to: string, message: TeamMessage): Promise<void> {
    const session = this.sessions.get(to);
    if (!session) throw new Error(`Teammate '${to}' is not running. Call ensureTeammate first.`);
    session.setSessionName(this.buildSessionLabel(to));
    const prompt = `<task-notification from="${message.from}">\n${message.message}\n</task-notification>`;
    await (session as any).prompt(prompt);
  }

  async deliverAll(message: Omit<TeamMessage, "to">): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.keys()).map(name =>
        this.deliver(name, { ...message, to: name })
      )
    );
  }

  getSession(name: string): AgentSession | undefined {
    return this.sessions.get(name);
  }

  async disposeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      (session as any).dispose();
    }
    this.sessions.clear();
  }
}
