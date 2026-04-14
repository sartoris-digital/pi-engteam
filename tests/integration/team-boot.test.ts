import { describe, it, expect } from "vitest";
import { MessageBus } from "../../src/team/MessageBus.js";
import type { TeamMessage } from "../../src/types.js";

describe("MessageBus integration", () => {
  it("routes a message to its named subscriber", async () => {
    const bus = new MessageBus();
    const received: TeamMessage[] = [];

    bus.subscribe("alice", (msg) => {
      received.push(msg);
      return Promise.resolve();
    });

    await bus.send({
      id: "1",
      from: "bob",
      to: "alice",
      summary: "hello",
      message: "hi there",
      ts: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].from).toBe("bob");
    expect(received[0].message).toBe("hi there");
  });

  it("does not deliver to the wrong subscriber", async () => {
    const bus = new MessageBus();
    const receivedAlice: TeamMessage[] = [];
    const receivedBob: TeamMessage[] = [];

    bus.subscribe("alice", (msg) => { receivedAlice.push(msg); return Promise.resolve(); });
    bus.subscribe("bob",   (msg) => { receivedBob.push(msg);   return Promise.resolve(); });

    await bus.send({
      id: "2",
      from: "system",
      to: "alice",
      summary: "direct",
      message: "only for alice",
      ts: new Date().toISOString(),
    });

    expect(receivedAlice).toHaveLength(1);
    expect(receivedBob).toHaveLength(0);
  });

  it("broadcasts to all subscribers except the sender", async () => {
    const bus = new MessageBus();
    const receivedA: TeamMessage[] = [];
    const receivedB: TeamMessage[] = [];

    bus.subscribe("alpha", (msg) => { receivedA.push(msg); return Promise.resolve(); });
    bus.subscribe("beta",  (msg) => { receivedB.push(msg); return Promise.resolve(); });

    await bus.broadcast("system", "hello all", "broadcast message");

    expect(receivedA.length).toBeGreaterThan(0);
    expect(receivedB.length).toBeGreaterThan(0);
  });

  it("broadcast excludes the sender", async () => {
    const bus = new MessageBus();
    const receivedSelf: TeamMessage[] = [];
    const receivedOther: TeamMessage[] = [];

    bus.subscribe("sender", (msg) => { receivedSelf.push(msg); return Promise.resolve(); });
    bus.subscribe("other",  (msg) => { receivedOther.push(msg); return Promise.resolve(); });

    await bus.broadcast("sender", "test", "should not receive own broadcast");

    expect(receivedSelf).toHaveLength(0);
    expect(receivedOther).toHaveLength(1);
  });

  it("unsubscribe removes the handler", async () => {
    const bus = new MessageBus();
    const received: TeamMessage[] = [];

    const unsubscribe = bus.subscribe("target", (msg) => {
      received.push(msg);
      return Promise.resolve();
    });

    unsubscribe();

    await bus.send({
      id: "3",
      from: "src",
      to: "target",
      summary: "after unsub",
      message: "should not arrive",
      ts: new Date().toISOString(),
    });

    expect(received).toHaveLength(0);
  });

  it("subscribeAll receives every message regardless of recipient", async () => {
    const bus = new MessageBus();
    const allMessages: TeamMessage[] = [];

    bus.subscribeAll((msg) => { allMessages.push(msg); return Promise.resolve(); });
    bus.subscribe("alice", () => Promise.resolve());
    bus.subscribe("bob",   () => Promise.resolve());

    await bus.send({ id: "4", from: "x", to: "alice", summary: "s", message: "m", ts: new Date().toISOString() });
    await bus.send({ id: "5", from: "x", to: "bob",   summary: "s", message: "m", ts: new Date().toISOString() });

    expect(allMessages).toHaveLength(2);
  });
});
