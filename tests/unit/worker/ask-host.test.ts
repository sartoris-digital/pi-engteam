import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_HOST_TOOL_NAME, createAskHostTool, factKeys, lookupFact } from "../../../src/worker/ask-host.js";
import { stageFactsPath } from "../../../src/controller/stage-facts.js";
import { generatedMarker } from "../../../src/runtime/marker.js";

const ctx = {} as unknown as ExtensionContext;

const FACTS = {
  lane: "build",
  stage: "implement",
  kind: "feature",
  tier: "low",
  ticketRef: "github:acme/app#12",
  branching: { base: "main", target: "main" },
  testDir: "tests",
  testPattern: "**/*.test.ts",
  writeRoots: ["src/**", "tests/**"],
  checks: ["typecheck", "unit"],
  maxDiffLines: 800,
  maxChangedFiles: 20,
  rules: [{ id: "r-1", text: "Always add a changelog entry." }],
};

describe("AskHost tool", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "pi-sdlc-askhost-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  async function seed(text: string): Promise<void> {
    await writeFile(stageFactsPath(runDir), text, { mode: 0o600 });
  }

  const tool = () => createAskHostTool({ runDir });
  const ask = (key: string) => tool().execute("c1", { key }, undefined, undefined, ctx);
  const textOf = (result: Awaited<ReturnType<typeof ask>>) =>
    result.content[0]?.type === "text" ? result.content[0].text : "";

  it("is registered under the contract name with a single key parameter", () => {
    const t = tool();
    expect(t.name).toBe(ASK_HOST_TOOL_NAME);
    expect(Object.keys(t.parameters.properties)).toEqual(["key"]);
  });

  it("reads the facts file past its generated marker line", async () => {
    await seed(`${generatedMarker("run-a1")}\n${JSON.stringify(FACTS, null, 2)}\n`);
    const result = await ask("testDir");
    expect(result.details).toEqual({ key: "testDir", found: true });
    expect(textOf(result)).toBe('testDir = "tests"');
  });

  it("resolves a dotted key path", async () => {
    await seed(`${generatedMarker("run-a1")}\n${JSON.stringify(FACTS)}\n`);
    expect(textOf(await ask("branching.base"))).toBe('branching.base = "main"');
    expect(textOf(await ask("branching.target"))).toBe('branching.target = "main"');
  });

  it("returns arrays and objects as JSON", async () => {
    await seed(`${generatedMarker("run-a1")}\n${JSON.stringify(FACTS)}\n`);
    expect(textOf(await ask("writeRoots"))).toBe('writeRoots = ["src/**","tests/**"]');
    expect(textOf(await ask("rules"))).toBe('rules = [{"id":"r-1","text":"Always add a changelog entry."}]');
  });

  it("lists the available keys instead of erroring on an unknown key", async () => {
    await seed(`${generatedMarker("run-a1")}\n${JSON.stringify(FACTS)}\n`);
    const result = await ask("test_directory");
    expect(result.details.found).toBe(false);
    expect(result.details.available).toContain("testDir");
    expect(result.details.available).toContain("branching.base");
    const text = textOf(result);
    expect(text).toContain('No host fact "test_directory"');
    expect(text).toContain("Available keys:");
    expect(text).toContain("branching.target");
  });

  it("lists available keys for a dotted path that dead-ends", async () => {
    await seed(`${generatedMarker("run-a1")}\n${JSON.stringify(FACTS)}\n`);
    const result = await ask("branching.origin");
    expect(result.details.found).toBe(false);
    expect(textOf(result)).toContain("Available keys:");
  });

  it("never reaches through the prototype chain", async () => {
    await seed(`${generatedMarker("run-a1")}\n${JSON.stringify(FACTS)}\n`);
    for (const key of ["constructor", "__proto__", "toString", "branching.constructor"]) {
      const result = await ask(key);
      expect(result.details.found).toBe(false);
    }
  });

  it("returns the graceful message when the facts file is missing", async () => {
    const result = await ask("testDir");
    expect(result.details).toEqual({ key: "testDir", found: false });
    expect(textOf(result)).toBe(
      "Host facts are unavailable for this run. Proceed on your own judgment and state the assumption you made in your verdict.",
    );
  });

  it("returns the graceful message when the facts file is malformed", async () => {
    await seed(`${generatedMarker("run-a1")}\n{ this is not json`);
    const result = await ask("testDir");
    expect(result.details).toEqual({ key: "testDir", found: false });
    expect(textOf(result)).toContain("Host facts are unavailable");
    expect(textOf(result)).toContain("state the assumption you made in your verdict");
  });

  it("returns the graceful message when the facts file is not an object", async () => {
    await seed(`${generatedMarker("run-a1")}\n"just a string"\n`);
    expect(textOf(await ask("testDir"))).toContain("Host facts are unavailable");
  });

  it("does not throw out of execute when the reader itself fails", async () => {
    const t = createAskHostTool({
      runDir,
      readFacts: () => {
        throw new Error("boom");
      },
    });
    const result = await t.execute("c1", { key: "testDir" }, undefined, undefined, ctx);
    expect(result.details.found).toBe(false);
    expect(textOf(result)).toContain("Host facts are unavailable");
  });

  it("does not throw out of execute on a rejected reader", async () => {
    const t = createAskHostTool({ runDir, readFacts: () => Promise.reject(new Error("EACCES")) });
    await expect(t.execute("c1", { key: "testDir" }, undefined, undefined, ctx)).resolves.toMatchObject({
      details: { found: false },
    });
  });

  it("writes nothing and reads only the facts file", async () => {
    let reads = 0;
    const t = createAskHostTool({
      runDir,
      readFacts: async () => {
        reads++;
        return JSON.stringify(FACTS);
      },
    });
    await t.execute("c1", { key: "checks" }, undefined, undefined, ctx);
    expect(reads).toBe(1);
    await expect(rm(stageFactsPath(runDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("factKeys / lookupFact", () => {
  it("flattens containers and treats arrays as leaves", () => {
    expect(factKeys({ a: 1, b: { c: 2 }, d: [{ e: 3 }] })).toEqual(["a", "b", "b.c", "d"]);
  });

  it("returns undefined for an empty key and for non-object roots", () => {
    expect(lookupFact(FACTS, "")).toBeUndefined();
    expect(lookupFact(null, "testDir")).toBeUndefined();
    expect(lookupFact(FACTS, "testDir.length")).toBeUndefined();
  });
});
