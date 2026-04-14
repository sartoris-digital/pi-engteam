import type { EngteamEvent, TeamMessage } from "../types.js";
import type { EventWriter } from "./writer.js";
import type { HttpSink } from "./httpSink.js";
import type { MessageBus } from "../team/MessageBus.js";

type SessionEvent = {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  toolResult?: { id: string; content: unknown; isError?: boolean };
};

export class Observer {
  constructor(
    private writer: EventWriter,
    private sink?: HttpSink,
  ) {}

  emit(partial: Omit<EngteamEvent, "ts">): void {
    const event: EngteamEvent = {
      ts: new Date().toISOString(),
      ...partial,
    };
    void this.writer.write(partial.runId, event);
    this.sink?.enqueue(event);
  }

  subscribeToSession(
    session: { subscribe: (l: (e: SessionEvent) => void) => () => void },
    runId: string,
    agentName: string,
    step?: string,
  ): () => void {
    return session.subscribe((event: SessionEvent) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        return;
      }

      if (event.type === "tool_call_start" && event.toolCall) {
        this.emit({
          runId,
          step,
          agentName,
          category: "tool_call",
          type: "start",
          payload: {
            toolName: event.toolCall.name,
            toolCallId: event.toolCall.id,
          },
          summary: `${agentName} calls ${event.toolCall.name}`,
        });
      }

      if (event.type === "tool_call_end" && event.toolResult) {
        this.emit({
          runId,
          step,
          agentName,
          category: "tool_result",
          type: event.toolResult.isError ? "error" : "ok",
          payload: {
            toolCallId: event.toolResult.id,
            isError: event.toolResult.isError ?? false,
          },
        });
      }
    });
  }

  subscribeToBus(bus: MessageBus, runId: string): () => void {
    return bus.subscribeAll((msg: TeamMessage) => {
      this.emit({
        runId,
        category: "message",
        type: "sent",
        payload: {
          from: msg.from,
          to: msg.to,
          summary: msg.summary,
          requestId: msg.requestId,
        },
        summary: `${msg.from} → ${msg.to}: ${msg.summary}`,
      });
    });
  }
}
