import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { MessageBus } from "../MessageBus.js";

export function createSendMessageTool(bus: MessageBus, senderName: string) {
  return defineTool({
    name: "SendMessage",
    label: "Send Message",
    description: "Send a message to another teammate by name, or broadcast to all with '*'.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name or '*' for broadcast" }),
      summary: Type.String({ description: "One-line summary for observability logs" }),
      message: Type.String({ description: "Full message body" }),
      requestId: Type.Optional(Type.String({ description: "Request ID for response pairing" })),
    }),
    execute: async (_id, params) => {
      await bus.send({
        id: crypto.randomUUID(),
        from: senderName,
        to: params.to,
        summary: params.summary,
        message: params.message,
        requestId: params.requestId,
        ts: new Date().toISOString(),
      });
      return {
        content: [{ type: "text" as const, text: `Message sent to ${params.to}` }],
        details: {},
      };
    },
  });
}
