import type { EngteamEvent, TeamMessage } from "../types.js";
import type { EventWriter } from "./writer.js";
import type { HttpSink } from "./httpSink.js";
import type { MessageBus } from "../team/MessageBus.js";
import { appendProjection } from "../adw/ConversationProjection.js";
import { join } from "path";

type SessionEvent = {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  toolResult?: { id: string; content: unknown; isError?: boolean };
};

// H3: a real run id matches the RUN_ID_RE shape used across /learn,
// /run-rollback, /run-cancel. Placeholders like "boot" or "none" are
// emitted before any run exists and must not create projection files.
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PLACEHOLDER_RUN_IDS = new Set(["boot", "none", "n/a", "unknown"]);
function isProjectableRunId(runId: string): boolean {
  if (PLACEHOLDER_RUN_IDS.has(runId)) return false;
  return RUN_ID_RE.test(runId);
}

export class Observer {
  constructor(
    private writer: EventWriter,
    private sink?: HttpSink,
    private runsDir?: string,
  ) {}

  emit(partial: Omit<EngteamEvent, "ts">, opts?: { host?: boolean }): void {
    const event: EngteamEvent = {
      ts: new Date().toISOString(),
      ...partial,
    };
    void this.writer.write(partial.runId, event);
    this.sink?.enqueue(event);
    // H3: skip placeholder/non-runId emissions ("boot", "none") and any
    // value that doesn't look like a real run id, otherwise we'd create
    // stray <runsDir>/boot/conversation.jsonl files on every startup.
    //
    // Round-2 C1: opts.host is the in-memory trust marker. Subprocess-
    // ingested events go through emit() with opts undefined so they can
    // never project as host-trusted, regardless of payload contents.
    if (this.runsDir && partial.runId && isProjectableRunId(partial.runId)) {
      void appendProjection(join(this.runsDir, partial.runId), event, opts?.host ?? false);
    }
  }

  /**
   * Synchronous projection variant. Useful when ordering matters — e.g.
   * the verifier's correction emit must reach conversation.jsonl BEFORE
   * the corrective team.deliver call returns the worker's reply.
   */
  async emitAwaited(partial: Omit<EngteamEvent, "ts">, opts?: { host?: boolean }): Promise<void> {
    const event: EngteamEvent = {
      ts: new Date().toISOString(),
      ...partial,
    };
    void this.writer.write(partial.runId, event);
    this.sink?.enqueue(event);
    if (this.runsDir && partial.runId && isProjectableRunId(partial.runId)) {
      await appendProjection(join(this.runsDir, partial.runId), event, opts?.host ?? false);
    }
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
      // Phase 4.5 round-1 H-2: include msg.message in the payload so the
      // dialogue projection can render full body content (capped) rather
      // than only the summary.
      this.emit({
        runId,
        category: "message",
        type: "sent",
        payload: {
          from: msg.from,
          to: msg.to,
          summary: msg.summary,
          message: msg.message,
          requestId: msg.requestId,
        },
        summary: `${msg.from} → ${msg.to}: ${msg.summary}`,
      });
    });
  }
}
