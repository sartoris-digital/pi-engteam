import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const dest = args.to === "*" ? theme.fg("muted", "broadcast") : theme.fg("accent", args.to);
      text.setText(`${dest}  ${args.summary}`);
      return text;
    },
    renderResult(result, _options, _theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const output = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map(c => c.text)
        .join("");
      text.setText(output);
      return text;
    },
  });
}
