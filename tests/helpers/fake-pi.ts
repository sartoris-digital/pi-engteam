import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Structural stand-ins for the Pi event shapes. `ToolCallEvent` / `ToolCallEventResult` are not
 * documented exports of @earendil-works/pi-coding-agent 0.84.x, so nothing imports them by name.
 */
export interface ToolCallEventLike {
  type?: string;
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown>;
}
export type ToolCallBlock = { block: true; reason?: string; terminate?: boolean };

type AnyHandler = (event: unknown, ctx: unknown) => unknown;

/** Structural stand-in for a registered tool: avoids depending on ToolDefinition's generic arity. */
export interface AnyTool {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: params and details vary per tool
  execute: (...args: any[]) => any;
  [key: string]: unknown;
}

/** Minimal ExtensionAPI stand-in: records registrations and replays events. Never touches a real Pi. */
export class FakePi {
  readonly tools: AnyTool[] = [];
  readonly handlers = new Map<string, AnyHandler[]>();
  readonly commands = new Map<string, unknown>();

  on(event: string, handler: AnyHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerTool(tool: AnyTool): void {
    this.tools.push(tool);
  }

  registerCommand(name: string, options: unknown): void {
    this.commands.set(name, options);
  }

  tool(name: string): AnyTool {
    const found = this.tools.find((t) => t.name === name);
    if (!found) throw new Error(`FakePi: tool ${name} is not registered`);
    return found;
  }

  hasTool(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  async emit(event: string, payload: unknown, ctx: unknown = {}): Promise<unknown> {
    for (const handler of this.handlers.get(event) ?? []) {
      const result = await handler(payload, ctx);
      if (result !== undefined && result !== null) return result;
    }
    return undefined;
  }

  asPi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}
