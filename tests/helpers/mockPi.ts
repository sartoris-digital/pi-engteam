import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Handler = (event: any, ctx: any) => Promise<any> | any;

export class MockExtensionAPI {
  private handlers = new Map<string, Handler[]>();
  registeredTools: any[] = [];
  registeredCommands: any[] = [];

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  registerTool(tool: any): void {
    this.registeredTools.push(tool);
  }

  registerCommand(cmd: any): void {
    this.registeredCommands.push(cmd);
  }

  async trigger(event: string, eventData: any, ctx: any = {}): Promise<any> {
    const handlers = this.handlers.get(event) ?? [];
    for (const h of handlers) {
      const result = await h(eventData, ctx);
      if (result != null) return result;
    }
    return undefined;
  }

  asPi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}
