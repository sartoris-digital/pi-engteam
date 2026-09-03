import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import {
  assertAutoMergeArgv,
  DirectMergeError,
  enqueueMergeQueue,
  mayEnqueueMergeQueue,
  maybeEnqueue,
  type MayEnqueueInput,
} from "../../../src/v3/merge-queue.js";

function src(): string {
  return readFileSync(fileURLToPath(new URL("../../../src/v3/merge-queue.ts", import.meta.url)), "utf8");
}

function input(over: Partial<MayEnqueueInput> = {}): MayEnqueueInput {
  return {
    cfg: { v3: { mergeQueue: { enabled: true } } },
    kind: "chore",
    tier: "low",
    touchesRisk: false,
    capabilities: new Set(["mergeQueue"]),
    ...over,
  };
}

describe("mayEnqueueMergeQueue", () => {
  it("is false on defaults / missing v3 block", () => {
    expect(mayEnqueueMergeQueue(input({ cfg: {} }))).toBe(false);
    expect(mayEnqueueMergeQueue(input({ cfg: { v3: DEFAULT_V3_POLICY } }))).toBe(false);
    expect(mayEnqueueMergeQueue(input({ cfg: { v3: { mergeQueue: { enabled: false } } } }))).toBe(false);
  });

  it("is false for feature, elevated chore, risk paths, or missing capability", () => {
    expect(mayEnqueueMergeQueue(input({ kind: "feature" }))).toBe(false);
    expect(mayEnqueueMergeQueue(input({ kind: "bug" }))).toBe(false);
    expect(mayEnqueueMergeQueue(input({ tier: "elevated" }))).toBe(false);
    expect(mayEnqueueMergeQueue(input({ touchesRisk: true }))).toBe(false);
    expect(mayEnqueueMergeQueue(input({ capabilities: new Set() }))).toBe(false);
    expect(mayEnqueueMergeQueue(input({ capabilities: new Set(["linkPR"]) }))).toBe(false);
  });

  it("is true only for flag-on low-tier chore without risk and with mergeQueue", () => {
    expect(mayEnqueueMergeQueue(input())).toBe(true);
  });
});

describe("assertAutoMergeArgv", () => {
  it("throws on a direct merge and accepts auto/queue flags", () => {
    expect(() => assertAutoMergeArgv(["pr", "merge", "1"])).toThrow(DirectMergeError);
    expect(() => assertAutoMergeArgv(["gh", "pr", "merge", "1"])).toThrow(DirectMergeError);
    expect(() => assertAutoMergeArgv(["git", "merge", "main"])).toThrow(DirectMergeError);
    expect(() => assertAutoMergeArgv(["merge", "main"])).toThrow(DirectMergeError);
    expect(() => assertAutoMergeArgv(["mr", "merge", "1"])).toThrow(DirectMergeError);
    expect(() => assertAutoMergeArgv(["glab", "mr", "merge", "1"])).toThrow(DirectMergeError);

    expect(() => assertAutoMergeArgv(["pr", "merge", "1", "--auto"])).not.toThrow();
    expect(() => assertAutoMergeArgv(["gh", "pr", "merge", "1", "--auto"])).not.toThrow();
    expect(() => assertAutoMergeArgv(["mr", "merge", "1", "--auto-merge"])).not.toThrow();
    expect(() => assertAutoMergeArgv(["glab", "mr", "merge", "1", "--when-pipeline-succeeds"])).not.toThrow();
  });
});

describe("maybeEnqueue", () => {
  it("does not call the adapter when policy denies, and never direct-merges", async () => {
    const calls: Array<{ url: string }> = [];
    const adapter = {
      enqueueMergeQueue: async (pr: { url: string }) => {
        calls.push(pr);
        return { queued: true, detail: "queued" };
      },
    };
    const denied = await maybeEnqueue({
      ...input({ cfg: {} }),
      adapter,
      pr: { url: "https://github.com/acme/widgets/pull/1" },
    });
    expect(denied).toEqual({ queued: false, detail: "policy-denied" });
    expect(calls).toEqual([]);

    const ok = await maybeEnqueue({
      ...input(),
      adapter,
      pr: { url: "https://github.com/acme/widgets/pull/1" },
    });
    expect(ok).toEqual({ queued: true, detail: "queued" });
    expect(calls).toEqual([{ url: "https://github.com/acme/widgets/pull/1" }]);
  });

  it("enqueueMergeQueue records through the adapter and does not spawn git/gh", async () => {
    const argvLog: string[][] = [];
    const result = await enqueueMergeQueue(
      {
        enqueueMergeQueue: async (pr) => {
          argvLog.push(["pr", "merge", "1", "--auto"]);
          assertAutoMergeArgv(argvLog[0]!);
          return { queued: true, detail: `auto:${pr.url}` };
        },
      },
      { url: "https://github.com/acme/widgets/pull/1" },
      argvLog,
    );
    expect(result.queued).toBe(true);
    expect(argvLog[0]).toContain("--auto");
    expect(src()).not.toMatch(/from ["']node:child_process["']/);
    expect(src()).not.toMatch(/execFile|spawn\(/);
  });
});
