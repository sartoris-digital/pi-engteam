import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { readQueue, runEnqueue } from "../../../src/commands/enqueue.js";
import { LocalAdapter } from "../../../src/trackers/local.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";

function depsFor(runs: string, repos: string[] = ["/repo"]): FactoryDeps {
  return {
    home: join(runs, ".."),
    runsDir: runs,
    projectRootDefault: "/pkg",
    engine: {} as FactoryDeps["engine"],
    executor: {} as FactoryDeps["executor"],
    provider: {} as FactoryDeps["provider"],
    tracker: new LocalAdapter(runs),
    agents: [],
    lanes: { chore: {} as FactoryDeps["lanes"][string] },
    piBinary: "pi",
    repos,
  };
}

describe("runEnqueue", () => {
  let runs: string;
  beforeEach(async () => {
    runs = await mkdtemp(join(tmpdir(), "pi-sdlc-enq-"));
  });
  afterEach(async () => {
    await rm(runs, { recursive: true, force: true });
  });

  it("mints a local ticket and appends a queued entry", async () => {
    const { ticket, entry } = await runEnqueue(
      parseFactoryArgs(`enqueue --task "add a greeting helper" --repo /repo --kind chore`),
      depsFor(runs),
    );
    expect(ticket.kind).toBe("chore");
    expect(ticket.title).toMatch(/add a greeting helper/i);
    expect(["queued", "ready"]).toContain(entry.state);
    expect(entry.ref).toBe(ticket.ref.id);
    const queue = await readQueue(runs);
    expect(queue.entries).toHaveLength(1);
    expect(queue.schemaVersion).toBe(1);
  });

  it("is idempotent on the same local ref already queued", async () => {
    const d = depsFor(runs);
    const first = await runEnqueue(parseFactoryArgs(`enqueue --task "same task" --repo /repo --kind chore`), d);
    const again = await runEnqueue(
      parseFactoryArgs(`enqueue ${first.ticket.ref.id} --repo /repo`),
      d,
    );
    expect((await readQueue(runs)).entries).toHaveLength(1);
    expect(again.entry.key).toBe(first.entry.key);
  });
});
