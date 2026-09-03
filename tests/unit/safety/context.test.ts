import { describe, expect, it } from "vitest";
import { generatedMarker as homeGeneratedMarker } from "../../../src/home.js";
import {
  RunContextError,
  generatedMarker,
  joinRootList,
  parseRootList,
  runContextFromEnv,
} from "../../../src/safety/context.js";
import { completeWorkerEnv, fakeRunContext } from "../../helpers/run-context.js";

describe("parseRootList / joinRootList (D3/R3)", () => {
  it("round-trips JSON arrays and treats empty as []", () => {
    expect(joinRootList(["docs/**", "README.md"])).toBe(JSON.stringify(["docs/**", "README.md"]));
    expect(parseRootList(joinRootList(["docs/**", "README.md"]))).toEqual(["docs/**", "README.md"]);
    expect(parseRootList("[]")).toEqual([]);
    expect(parseRootList(undefined)).toEqual([]);
    expect(parseRootList("")).toEqual([]);
    expect(parseRootList("   ")).toEqual([]);
  });

  it("returns [] for invalid JSON rather than inventing a separator encoding", () => {
    expect(parseRootList("not-json")).toEqual([]);
    expect(parseRootList("[")).toEqual([]);
    expect(parseRootList('["docs/**"]')).toEqual(["docs/**"]);
    expect(parseRootList('{"x":1}')).toEqual([]);
    expect(parseRootList("[1,2]")).toEqual([]);
  });
});

describe("runContextFromEnv (D4/R4)", () => {
  it("returns null when the env is missing or partial", () => {
    expect(runContextFromEnv({})).toBeNull();
    expect(runContextFromEnv({ PI_SDLC_AGENT_MODE: "1" })).toBeNull();
    expect(runContextFromEnv({ PI_SDLC_RUN_ID: "run-0001" })).toBeNull();
    const env = completeWorkerEnv();
    delete env.PI_SDLC_NONCE;
    expect(runContextFromEnv(env)).toBeNull();
    expect(runContextFromEnv(completeWorkerEnv({ PI_SDLC_STEP: "   " }))).toBeNull();
  });

  it("builds RunContext from a complete worker env, defaulting extra/deny to []", () => {
    const ctx = runContextFromEnv(completeWorkerEnv());
    expect(ctx).toEqual({
      runId: "run-0001",
      runsDir: "/Users/op/.pi/sdlc-factory/runs",
      runDir: "/Users/op/.pi/sdlc-factory/runs/run-0001",
      stage: "implement",
      agent: "implementer",
      workspaceDir: "/repos/app",
      projectRoot: "/repos/app-main",
      policyFile: "/Users/op/.pi/sdlc-factory/runs/_factory/policy/abc.yaml",
      policySha: "a".repeat(64),
      extraUpsert: [],
      denyUpsert: [],
      nonce: "n0nce",
    });
    const withRoots = runContextFromEnv(
      completeWorkerEnv({
        PI_SDLC_EXTRA_UPSERT: JSON.stringify(["docs/**", "README.md"]),
        PI_SDLC_DENY_UPSERT: JSON.stringify(["tests/**"]),
      }),
    );
    expect(withRoots?.extraUpsert).toEqual(["docs/**", "README.md"]);
    expect(withRoots?.denyUpsert).toEqual(["tests/**"]);
  });

  it("throws RunContextError for a present-but-malformed run id", () => {
    expect(() => runContextFromEnv(completeWorkerEnv({ PI_SDLC_RUN_ID: "_factory" }))).toThrow(RunContextError);
    expect(() => runContextFromEnv(completeWorkerEnv({ PI_SDLC_RUN_ID: "../x" }))).toThrow(/run-id|invalid runId/);
    expect(() => runContextFromEnv(completeWorkerEnv({ PI_SDLC_RUN_ID: "a/b" }))).toThrow(RunContextError);
    try {
      runContextFromEnv(completeWorkerEnv({ PI_SDLC_RUN_ID: "-lead" }));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunContextError);
      expect((error as RunContextError).code).toBe("run-id");
    }
  });

  it("throws RunContextError for a present-but-malformed root list", () => {
    expect(() => runContextFromEnv(completeWorkerEnv({ PI_SDLC_EXTRA_UPSERT: "not-json" }))).toThrow(RunContextError);
    expect(() => runContextFromEnv(completeWorkerEnv({ PI_SDLC_DENY_UPSERT: "docs/**" }))).toThrow(RunContextError);
    try {
      runContextFromEnv(completeWorkerEnv({ PI_SDLC_EXTRA_UPSERT: "[1]" }));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunContextError);
      expect((error as RunContextError).code).toBe("root-list");
    }
  });
});

describe("generatedMarker re-export (D17)", () => {
  it("is the home.ts function, not a second literal", () => {
    expect(generatedMarker).toBe(homeGeneratedMarker);
    expect(generatedMarker("run-0001")).toBe("<!-- pi-sdlc-factory generated · run run-0001 · do not commit -->");
  });
});

describe("fakeRunContext helper", () => {
  it("defaults to the implementer and lets overrides win", () => {
    expect(fakeRunContext().agent).toBe("implementer");
    expect(fakeRunContext({ agent: "reviewer", stage: "review" }).stage).toBe("review");
    expect(fakeRunContext({ runDir: "/tmp/r" }).runDir).toBe("/tmp/r");
  });
});
