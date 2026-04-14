import type { TeamMessage } from "../types.js";

type MessageHandler = (msg: TeamMessage) => void | Promise<void>;

export class MessageBus {
  private subscribers = new Map<string, MessageHandler[]>();
  private globalListeners: MessageHandler[] = [];

  subscribe(name: string, handler: MessageHandler): () => void {
    if (!this.subscribers.has(name)) this.subscribers.set(name, []);
    this.subscribers.get(name)!.push(handler);
    return () => {
      const handlers = this.subscribers.get(name);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  subscribeAll(handler: MessageHandler): () => void {
    this.globalListeners.push(handler);
    return () => {
      const idx = this.globalListeners.indexOf(handler);
      if (idx !== -1) this.globalListeners.splice(idx, 1);
    };
  }

  async send(msg: TeamMessage): Promise<void> {
    for (const listener of this.globalListeners) {
      await listener(msg);
    }
    if (msg.to === "*") {
      for (const [name, handlers] of this.subscribers) {
        if (name === msg.from) continue;
        for (const h of handlers) await h(msg);
      }
    } else {
      const handlers = this.subscribers.get(msg.to) ?? [];
      for (const h of handlers) await h(msg);
    }
  }

  async broadcast(from: string, summary: string, message: string): Promise<void> {
    await this.send({
      id: crypto.randomUUID(),
      from,
      to: "*",
      summary,
      message,
      ts: new Date().toISOString(),
    });
  }
}
