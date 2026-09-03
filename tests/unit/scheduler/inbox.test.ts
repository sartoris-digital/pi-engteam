import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainInbox, enqueueInbox, inboxDir } from "../../../src/scheduler/inbox.js";

describe("inbox", () => {
  it("drains three requests FIFO and deletes the files", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-inbox-"));
    try {
      const ids = [
        await enqueueInbox(runs, { n: 1 }),
        await enqueueInbox(runs, { n: 2 }),
        await enqueueInbox(runs, { n: 3 }),
      ];
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      const drained = await drainInbox(runs);
      expect(drained).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      await expect(readdir(inboxDir(runs))).resolves.toEqual([]);
      expect(await drainInbox(runs)).toEqual([]);
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });
});
