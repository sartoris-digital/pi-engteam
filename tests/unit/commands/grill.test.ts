import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGrill } from "../../../src/commands/grill.js";
import { readQueue } from "../../../src/commands/enqueue.js";
import type { ParsedFactoryArgs } from "../../../src/commands/router.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { LocalAdapter } from "../../../src/trackers/local.js";

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
    lanes: { chore: {} as FactoryDeps["lanes"][string], grill: {} as FactoryDeps["lanes"][string] },
    piBinary: "pi",
    repos,
  };
}

describe("runGrill", () => {
  let runs: string;
  beforeEach(async () => {
    runs = await mkdtemp(join(tmpdir(), "pi-sdlc-grill-"));
  });
  afterEach(async () => {
    await rm(runs, { recursive: true, force: true });
  });

  it("aliases enqueue --task with lane grill", async () => {
    const parsed: ParsedFactoryArgs = {
      verb: "enqueue",
      args: ["thin idea for a helper"],
      flags: { repo: "/repo" },
    };
    const { entry } = await runGrill(parsed, depsFor(runs));
    expect(entry.lane).toBe("grill");
    expect(entry.state).toBe("queued");
    const queue = await readQueue(runs);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]?.lane).toBe("grill");
  });
});
