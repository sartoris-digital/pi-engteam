import { describe, it, expect, vi } from "vitest";
import { MessageBus } from "../../../src/team/MessageBus.js";
import type { TeamMessage } from "../../../src/types.js";

function makeMsg(from: string, to: string, n: number): TeamMessage {
  return {
    id: `msg-${n}`,
    from,
    to,
    summary: `message ${n}`,
    message: `body ${n}`,
    ts: new Date().toISOString(),
  };
}

describe("MessageBus", () => {
  it("delivers a direct message to the correct recipient", async () => {
    const bus = new MessageBus();
    const received: TeamMessage[] = [];
    bus.subscribe("bob", async (msg) => { received.push(msg); });
    await bus.send(makeMsg("alice", "bob", 1));
    expect(received).toHaveLength(1);
    expect(received[0].from).toBe("alice");
  });

  it("does not deliver to unintended recipients", async () => {
    const bus = new MessageBus();
    const aliceReceived: TeamMessage[] = [];
    const bobReceived: TeamMessage[] = [];
    bus.subscribe("alice", async (msg) => { aliceReceived.push(msg); });
    bus.subscribe("bob", async (msg) => { bobReceived.push(msg); });
    await bus.send(makeMsg("alice", "bob", 1));
    expect(bobReceived).toHaveLength(1);
    expect(aliceReceived).toHaveLength(0);
  });

  it("delivers broadcast to all except sender", async () => {
    const bus = new MessageBus();
    const received: Record<string, TeamMessage[]> = { alice: [], bob: [], carol: [] };
    bus.subscribe("alice", async (msg) => { received.alice.push(msg); });
    bus.subscribe("bob", async (msg) => { received.bob.push(msg); });
    bus.subscribe("carol", async (msg) => { received.carol.push(msg); });
    await bus.broadcast("alice", "hello all", "Hi everyone");
    expect(received.alice).toHaveLength(0);
    expect(received.bob).toHaveLength(1);
    expect(received.carol).toHaveLength(1);
  });

  it("preserves FIFO order per recipient", async () => {
    const bus = new MessageBus();
    const order: number[] = [];
    bus.subscribe("bob", async (msg) => { order.push(parseInt(msg.id.replace("msg-", ""))); });
    await bus.send(makeMsg("alice", "bob", 1));
    await bus.send(makeMsg("alice", "bob", 2));
    await bus.send(makeMsg("alice", "bob", 3));
    expect(order).toEqual([1, 2, 3]);
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new MessageBus();
    const received: TeamMessage[] = [];
    const unsub = bus.subscribe("bob", async (msg) => { received.push(msg); });
    await bus.send(makeMsg("alice", "bob", 1));
    unsub();
    await bus.send(makeMsg("alice", "bob", 2));
    expect(received).toHaveLength(1);
  });

  it("subscribeAll receives all messages", async () => {
    const bus = new MessageBus();
    const all: TeamMessage[] = [];
    bus.subscribeAll(async (msg) => { all.push(msg); });
    bus.subscribe("bob", async () => {});
    await bus.send(makeMsg("alice", "bob", 1));
    expect(all).toHaveLength(1);
  });
});
